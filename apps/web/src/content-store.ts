import { PagedReducer, ActivityIndex } from "@agentlive/playback";
import {
  TextContent,
  canonicalJson,
  validateTextReference,
  idSchema,
  ProtocolError,
  type TextReference,
  snapshotDescriptorSchema,
  snapshotContentReferenceSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import type { BrowserView, CacheBinding } from "./history-cache.js";
export type BrowserCheckpoint = SnapshotDescriptor & {
  activity?: TextReference;
};
const browserCheckpointSchema = snapshotDescriptorSchema.extend({
  activity: snapshotContentReferenceSchema
    .extend({ units: snapshotContentReferenceSchema.shape.units.max(32768) })
    .optional(),
});
const DATABASE = "agentlive-content-v1",
  MAX_TOTAL = 512 * 1024 * 1024;
const encoder = new TextEncoder();
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function bad(): never {
  throw new ProtocolError("corrupt_storage", "Invalid browser content storage");
}
/** Immutable local content. Root publication and eviction recovery belong to the caller. */
export class BrowserContentStore {
  private readonly stop = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing: Promise<void> | undefined;
  private readonly codec: TextContent;
  private constructor(
    private readonly db: IDBDatabase,
    private readonly scope: string,
    private readonly maxBytes: number,
    private readonly binding: { streamId: string; revision: string },
  ) {
    this.codec = new TextContent({
      load: (ref, signal) => this.load(ref, signal!),
      save: (value, units, signal) => this.save(value, units, signal!),
      flush: async (signal) => {
        signal?.throwIfAborted();
      },
    });
    db.onversionchange = () => {
      void this.close();
    };
  }
  static async open(
    factory: IDBFactory,
    binding: CacheBinding,
    parent: AbortSignal,
    maxBytes = MAX_TOTAL,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TOTAL)
      throw new RangeError("Invalid browser content quota");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    signal.throwIfAborted();
    binding = {
      serverOrigin: new URL(binding.serverOrigin).origin,
      streamId: idSchema.parse(binding.streamId),
      revision: idSchema.parse(binding.revision),
    };
    const scope = await hash(
      encoder.encode(
        canonicalJson({
          serverOrigin: new URL(binding.serverOrigin).origin,
          streamId: idSchema.parse(binding.streamId),
          revision: idSchema.parse(binding.revision),
        }),
      ),
    );
    signal.throwIfAborted();
    return new Promise<BrowserContentStore>((resolve, reject) => {
      const request = factory.open(DATABASE, 1),
        abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.onupgradeneeded = () => {
        if (signal.aborted) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore("blobs");
        request.result.createObjectStore("meta").put(0, "bytes");
      };
      request.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(request.error);
      };
      request.onsuccess = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          request.result.close();
          reject(signal.reason);
        } else
          resolve(
            new BrowserContentStore(request.result, scope, maxBytes, {
              streamId: binding.streamId,
              revision: binding.revision,
            }),
          );
      };
      if (signal.aborted) abort();
    });
  }
  private transaction<T>(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    work: (
      tx: IDBTransaction,
      read: <V>(request: IDBRequest<V>, next: (value: V) => void) => void,
      result: (value: T) => void,
    ) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["blobs", "meta"], mode);
      let value: T, failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {}
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      tx.oncomplete = () => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      tx.onabort = () => {
        signal.removeEventListener("abort", abort);
        reject(failure ?? tx.error ?? new Error("Content transaction aborted"));
      };
      try {
        work(
          tx,
          (request, next) => {
            request.onsuccess = () => {
              try {
                next(request.result);
              } catch (error) {
                fail(error);
              }
            };
          },
          (result) => {
            value = result;
          },
        );
        if (signal.aborted) abort();
      } catch (error) {
        fail(error);
      }
    });
  }
  private async load(
    ref: TextReference,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    validateTextReference(ref, 67108864);
    const bytes = await this.transaction<unknown>(
      "readonly",
      signal,
      (tx, read, result) =>
        read(tx.objectStore("blobs").get(`${this.scope}:${ref.hash}`), result),
    );
    if (!(bytes instanceof Uint8Array) || bytes.length !== ref.byteSize) bad();
    if ((await hash(bytes)) !== ref.hash) bad();
    signal.throwIfAborted();
    return bytes;
  }
  private async save(
    value: unknown,
    units: number,
    signal: AbortSignal,
  ): Promise<TextReference> {
    signal.throwIfAborted();
    const bytes = encoder.encode(canonicalJson(value));
    if (bytes.length > 1048576)
      throw new RangeError("Content blob exceeds limit");
    const ref = { hash: await hash(bytes), byteSize: bytes.length, units };
    validateTextReference(ref, 67108864);
    signal.throwIfAborted();
    await this.transaction<void>("readwrite", signal, (tx, read, result) => {
      const blobs = tx.objectStore("blobs"),
        meta = tx.objectStore("meta"),
        key = `${this.scope}:${ref.hash}`;
      read(blobs.get(key), (existing) => {
        if (existing !== undefined) {
          if (
            !(existing instanceof Uint8Array) ||
            existing.length !== bytes.length ||
            existing.some((byte, index) => byte !== bytes[index])
          )
            bad();
          result();
          return;
        }
        read(meta.get("bytes"), (raw) => {
          const used = raw;
          if (!Number.isSafeInteger(used) || used < 0 || used > MAX_TOTAL)
            bad();
          if (used + bytes.length > this.maxBytes)
            throw new ProtocolError(
              "retry_later",
              "Browser content quota exceeded",
            );
          blobs.put(bytes, key);
          meta.put(used + bytes.length, "bytes");
          result();
        });
      });
    });
    signal.throwIfAborted();
    return ref;
  }
  private run<T>(
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Browser content store is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Browser content queue is full"),
      );
    const signal = AbortSignal.any([
      this.stop.signal,
      AbortSignal.timeout(10000),
      ...(parent ? [parent] : []),
    ]);
    this.pending++;
    const task = this.tail
      .then(async () => {
        signal.throwIfAborted();
        const result = await operation(signal);
        signal.throwIfAborted();
        return result;
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  put(source: string | AsyncIterable<string>, signal?: AbortSignal) {
    return this.run(signal, (active) => this.codec.put(source, active));
  }
  append(
    ref: TextReference,
    source: string | AsyncIterable<string>,
    signal?: AbortSignal,
  ) {
    ref = { ...ref };
    return this.run(signal, (active) => this.codec.append(ref, source, active));
  }
  read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    ref = { ...ref };
    return this.run(signal, (active) =>
      this.codec.read(ref, offset, length, active),
    );
  }
  private checkpoint(value: unknown): BrowserCheckpoint {
    const parsed = browserCheckpointSchema.safeParse(value);
    if (!parsed.success || parsed.data.format !== "agentlive.paged-state")
      bad();
    const { activity, ...state } = parsed.data;
    return activity ? { ...state, activity } : state;
  }
  loadCheckpoint(signal?: AbortSignal): Promise<BrowserCheckpoint | null> {
    return this.run(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`root:${this.scope}`), (value) =>
          result(value === undefined ? null : this.checkpoint(value)),
        );
      }),
    );
  }
  /** Atomically choose a completed reducer root. A stale writer must reopen before retrying. */
  publishCheckpoint(
    expected: BrowserCheckpoint | null,
    next: BrowserCheckpoint,
    signal?: AbortSignal,
  ): Promise<BrowserCheckpoint> {
    expected = expected === null ? null : this.checkpoint(expected);
    next = this.checkpoint(next);
    return this.run(signal, async (active) => {
      // Use the codec directly inside store admission; public read would re-enter this queue.
      const reducer = new PagedReducer({
        read: (ref, offset, length, signal) =>
          this.codec.read(ref, offset, length, signal),
        put: async () => {
          throw new Error("Checkpoint validation is read-only");
        },
        append: async () => {
          throw new Error("Checkpoint validation is read-only");
        },
      });
      const state = await reducer.open(next.ref, this.binding, active);
      if (
        state.appliedSeq !== next.serverSeq ||
        state.timelineMs !== next.timelineMs
      )
        bad();
      if (next.activity) {
        const index = new ActivityIndex({
          read: (ref, offset, length, signal) =>
            this.codec.read(ref, offset, length, signal),
          put: async () => {
            throw new Error("Checkpoint validation is read-only");
          },
        });
        const root = await index.open(next.activity, this.binding, active);
        if (
          root.appliedSeq !== next.serverSeq ||
          root.gaps !== (state.maps.gaps?.size ?? 0)
        )
          bad();
      }
      return this.transaction("readwrite", active, (tx, read, result) => {
        const meta = tx.objectStore("meta"),
          key = `root:${this.scope}`;
        read(meta.get(key), (raw) => {
          const current = raw === undefined ? null : this.checkpoint(raw);
          if (canonicalJson(current) === canonicalJson(next)) {
            result(next);
            return;
          }
          if (canonicalJson(current) !== canonicalJson(expected))
            throw new ProtocolError(
              "event_conflict",
              "Browser checkpoint changed in another writer",
            );
          const { activity: nextActivity, ...nextState } = next;
          const upgrade =
            current &&
            !current.activity &&
            nextActivity &&
            canonicalJson(current) === canonicalJson(nextState);
          if (
            current &&
            !upgrade &&
            (next.serverSeq <= current.serverSeq ||
              next.timelineMs < current.timelineMs)
          )
            throw new ProtocolError(
              "event_conflict",
              "Browser checkpoint cannot move backward or replace a sequence",
            );
          meta.put(next, key);
          result(next);
        });
      });
    });
  }
  private presentation(value: unknown): BrowserView {
    const v = value as BrowserView;
    if (
      !v ||
      typeof v !== "object" ||
      Object.keys(v).sort().join(",") !== "mode,serverSeq,speed,timelineMs" ||
      !Number.isSafeInteger(v.serverSeq) ||
      v.serverSeq < 0 ||
      !Number.isFinite(v.timelineMs) ||
      v.timelineMs < 0 ||
      !Number.isFinite(v.speed) ||
      v.speed < 1 / 1024 ||
      v.speed > 1024 ||
      !["follow", "paused", "playing"].includes(v.mode)
    )
      bad();
    return { ...v };
  }
  loadView(signal: AbortSignal): Promise<BrowserView | undefined> {
    return this.run(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`view:${this.scope}`), (raw) =>
          result(raw === undefined ? undefined : this.presentation(raw)),
        );
      }),
    );
  }
  saveView(input: BrowserView, signal: AbortSignal): Promise<void> {
    const view = this.presentation(input);
    return this.run(signal, (active) =>
      this.transaction("readwrite", active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`root:${this.scope}`), (raw) => {
          const head = raw === undefined ? null : this.checkpoint(raw);
          if (
            view.serverSeq > (head?.serverSeq ?? 0) ||
            view.timelineMs > (head?.timelineMs ?? 0)
          )
            throw new ProtocolError(
              "precondition_failed",
              "Playback preference exceeds saved receipt",
            );
          meta.put(view, `view:${this.scope}`);
          result(undefined);
        });
      }),
    );
  }
  static async clear(factory: IDBFactory, parent: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(DATABASE),
        abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.onsuccess = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      request.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(request.error);
      };
      if (signal.aborted) abort();
    });
  }
  close() {
    if (!this.closing) {
      this.stop.abort(new Error("Browser content store is closing"));
      this.closing = this.tail.then(() => this.db.close());
    }
    return this.closing;
  }
}
