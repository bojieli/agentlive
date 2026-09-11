import {
  textPageChoices,
  changeTextPage,
  textPosition,
  type TextPageChoice,
  type TextPosition,
} from "./inspection-choices.js";
import {
  expansionChoices,
  expansionKey,
  changeExpansion,
} from "./inspection-choices.js";
import {
  MAX_SEEK_CHECKPOINTS,
  retainSeekCheckpoint,
} from "./checkpoint-catalog.js";
import { PagedReducer, ActivityIndex } from "@agentlive/playback";
import {
  TextContent,
  attachmentSchema,
  canonicalJson,
  validateTextReference,
  idSchema,
  ProtocolError,
  type TextReference,
  snapshotDescriptorSchema,
  snapshotLeaseSchema,
  type SnapshotLease,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import type { BrowserView, CacheBinding } from "./history-cache.js";
export type SnapshotBlobLoader = (
  ref: TextReference,
  signal: AbortSignal,
) => Promise<Uint8Array>;
export type BrowserCheckpoint = SnapshotDescriptor & {
  activity?: TextReference;
};
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
  private generation = 0;
  private leaseTail: Promise<void> = Promise.resolve();
  private leasePending = 0;
  private closing: Promise<void> | undefined;
  private readonly codec: TextContent;
  private constructor(
    private readonly db: IDBDatabase,
    private readonly scope: string,
    private readonly maxBytes: number,
    private readonly binding: { streamId: string; revision: string },
    private readonly loader?: SnapshotBlobLoader,
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
    loader?: SnapshotBlobLoader,
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
    const store = await new Promise<BrowserContentStore>((resolve, reject) => {
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
            new BrowserContentStore(
              request.result,
              scope,
              maxBytes,
              {
                streamId: binding.streamId,
                revision: binding.revision,
              },
              loader,
            ),
          );
      };
      if (signal.aborted) abort();
    });
    try {
      store.generation = await store.transaction(
        "readonly",
        signal,
        (tx, read, result) => {
          read(tx.objectStore("meta").get(`generation:${scope}`), (value) =>
            result(store.parseGeneration(value)),
          );
        },
      );
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  private parseGeneration(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      bad();
    return value;
  }
  private async rootTransaction<T>(
    signal: AbortSignal,
    work: (
      tx: IDBTransaction,
      read: <V>(request: IDBRequest<V>, next: (value: V) => void) => void,
      result: (value: T) => void,
      invalidate: () => void,
    ) => void,
  ): Promise<T> {
    let committedGeneration = this.generation;
    const value = await this.transaction<T>(
      "readwrite",
      signal,
      (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`generation:${this.scope}`), (raw) => {
          const current = this.parseGeneration(raw);
          if (current !== this.generation)
            throw new ProtocolError(
              "stale_lease",
              "Browser roots were invalidated; reopen before publishing",
            );
          committedGeneration = current;
          work(tx, read, result, () => {
            if (current === Number.MAX_SAFE_INTEGER) bad();
            committedGeneration = current + 1;
            meta.put(committedGeneration, `generation:${this.scope}`);
          });
        });
      },
    );
    this.generation = committedGeneration;
    return value;
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
      let failed = false;
      const fail = (error: unknown) => {
        if (!failed) {
          failed = true;
          failure = error;
        }
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
    let bytes = await this.transaction<unknown>(
      "readonly",
      signal,
      (tx, read, result) =>
        read(tx.objectStore("blobs").get(`${this.scope}:${ref.hash}`), result),
    );
    if (bytes === undefined && this.loader) {
      signal.throwIfAborted();
      const remote = await new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return this.loader!({ ...ref }, signal);
          })
          .then(resolve, reject)
          .finally(cleanup);
      });
      signal.throwIfAborted();
      if (!(remote instanceof Uint8Array) || remote.length !== ref.byteSize)
        bad();
      const downloaded = new Uint8Array(remote);
      if ((await hash(downloaded)) !== ref.hash) bad();
      await this.install(ref, downloaded, signal);
      bytes = downloaded;
    }
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
    await this.install(ref, bytes, signal);
    return ref;
  }
  private async install(
    ref: TextReference,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
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
  /** Complete verified codec dependency set, without checkpoint publication or collection. */
  trace(ref: TextReference, signal?: AbortSignal) {
    ref = { ...ref };
    return this.run(signal, (active) => this.codec.trace(ref, active));
  }
  /** Lease metadata must progress while a content loader waits for renewal. */
  private runLease<T>(
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Browser content store is closing"));
    if (this.leasePending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Browser lease queue is full"),
      );
    const signal = AbortSignal.any([
      this.stop.signal,
      AbortSignal.timeout(10000),
      ...(parent ? [parent] : []),
    ]);
    this.leasePending++;
    const task = this.leaseTail
      .then(async () => {
        signal.throwIfAborted();
        const result = await operation(signal);
        signal.throwIfAborted();
        return result;
      })
      .finally(() => {
        this.leasePending--;
      });
    this.leaseTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private leases(value: unknown): SnapshotLease[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 128) bad();
    const leases = value.map((item) => snapshotLeaseSchema.parse(item));
    if (new Set(leases.map((item) => item.token)).size !== leases.length) bad();
    return leases;
  }
  loadSnapshotLeases(signal?: AbortSignal): Promise<SnapshotLease[]> {
    return this.runLease(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`leases:${this.scope}`), (raw) =>
          result(this.leases(raw)),
        );
      }),
    );
  }
  /** Compare-and-set provenance. Never evict another reader's roots to admit a lease.
   * The expected record fences a late renewal after release or another tab's update.
   */
  saveSnapshotLease(
    expected: SnapshotLease | null,
    next: SnapshotLease | null,
    signal: AbortSignal,
  ): Promise<void> {
    const previous =
      expected === null ? null : snapshotLeaseSchema.parse(expected);
    const saved = next === null ? null : snapshotLeaseSchema.parse(next);
    if (!previous && !saved)
      return Promise.reject(new RangeError("Missing snapshot lease"));
    if (
      previous &&
      saved &&
      (previous.token !== saved.token ||
        canonicalJson(previous.snapshot) !== canonicalJson(saved.snapshot) ||
        saved.expiresAt < previous.expiresAt)
    )
      return Promise.reject(
        new ProtocolError(
          "precondition_failed",
          "Snapshot lease renewal changed provenance",
        ),
      );
    const token = (saved ?? previous)!.token;
    return this.runLease(signal, (active) =>
      this.rootTransaction(active, (tx, read, result) => {
        const meta = tx.objectStore("meta"),
          key = `leases:${this.scope}`;
        read(meta.get(key), (raw) => {
          active.throwIfAborted();
          const leases = this.leases(raw),
            current = leases.find((item) => item.token === token) ?? null;
          if (canonicalJson(current) !== canonicalJson(previous))
            throw new ProtocolError(
              "precondition_failed",
              "Snapshot lease provenance changed",
            );
          const retained = leases.filter((item) => item.token !== token);
          if (saved) retained.push(saved);
          if (retained.length > 128)
            throw new ProtocolError(
              "retry_later",
              "Snapshot lease cache is at capacity",
            );
          meta.put(retained, key);
          result(undefined);
        });
      }),
    );
  }
  /** Merge concurrent renewals of the same retained snapshot without resurrecting
   * a released token or replacing its roots. Expiry may only move forward.
   */
  renewSnapshotLease(
    input: SnapshotLease,
    signal: AbortSignal,
  ): Promise<SnapshotLease> {
    const next = snapshotLeaseSchema.parse(input);
    return this.runLease(signal, (active) =>
      this.transaction("readwrite", active, (tx, read, result) => {
        const meta = tx.objectStore("meta"),
          key = `leases:${this.scope}`;
        read(meta.get(key), (raw) => {
          const leases = this.leases(raw),
            index = leases.findIndex((item) => item.token === next.token);
          const current = leases[index];
          if (!current)
            throw new ProtocolError(
              "stale_lease",
              "Cached snapshot lease was removed",
            );
          if (canonicalJson(current.snapshot) !== canonicalJson(next.snapshot))
            throw new ProtocolError(
              "event_conflict",
              "Snapshot lease roots changed",
            );
          active.throwIfAborted();
          const saved = current.expiresAt >= next.expiresAt ? current : next;
          leases[index] = saved;
          meta.put(leases, key);
          result(saved);
        });
      }),
    );
  }
  /** Discard derivative roots after lease recovery fails. History and saved view
   * are retained for reconstruction. Caller closes active paged readers first.
   */
  invalidateSnapshotRoots(
    expectedHead: BrowserCheckpoint | null,
    expectedLeases: readonly SnapshotLease[],
    signal: AbortSignal,
  ): Promise<void> {
    const head = expectedHead === null ? null : this.checkpoint(expectedHead);
    const leases = this.leases(expectedLeases);
    return this.run(signal, (active) =>
      this.rootTransaction(active, (tx, read, result, invalidate) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`root:${this.scope}`), (raw) => {
          const current = raw === undefined ? null : this.checkpoint(raw);
          if (canonicalJson(current) !== canonicalJson(head))
            throw new ProtocolError(
              "event_conflict",
              "Browser checkpoint changed during recovery",
            );
          read(meta.get(`leases:${this.scope}`), (rawLeases) => {
            if (canonicalJson(this.leases(rawLeases)) !== canonicalJson(leases))
              throw new ProtocolError(
                "event_conflict",
                "Snapshot leases changed during recovery",
              );
            read(meta.get(`recovery:${this.scope}`), (through) => {
              if (
                through !== undefined &&
                (!Number.isSafeInteger(through) || through < 0)
              )
                bad();
              active.throwIfAborted();
              meta.put(
                Math.max(through ?? 0, head?.serverSeq ?? 0),
                `recovery:${this.scope}`,
              );
              invalidate();
              meta.delete(`root:${this.scope}`);
              meta.delete(`seek:${this.scope}`);
              meta.delete(`leases:${this.scope}`);
              result(undefined);
            });
          });
        });
      }),
    );
  }
  /** One-time migration for caches whose derivative roots may contain imports
   * created before lease provenance existed. Preserve authoritative history/view.
   */
  prepareSnapshotRetention(signal: AbortSignal): Promise<void> {
    return this.run(signal, (active) =>
      this.rootTransaction(active, (tx, read, result, invalidate) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`retention-format:${this.scope}`), (version) => {
          if (version === 1) {
            result(undefined);
            return;
          }
          if (version !== undefined) bad();
          read(meta.get(`root:${this.scope}`), (raw) => {
            const head = raw === undefined ? null : this.checkpoint(raw);
            read(meta.get(`recovery:${this.scope}`), (through) => {
              if (
                through !== undefined &&
                (!Number.isSafeInteger(through) || through < 0)
              )
                bad();
              active.throwIfAborted();
              meta.put(
                Math.max(through ?? 0, head?.serverSeq ?? 0),
                `recovery:${this.scope}`,
              );
              invalidate();
              meta.delete(`root:${this.scope}`);
              meta.delete(`seek:${this.scope}`);
              meta.delete(`leases:${this.scope}`);
              meta.put(1, `retention-format:${this.scope}`);
              result(undefined);
            });
          });
        });
      }),
    );
  }
  loadRecoveryThrough(signal: AbortSignal): Promise<number> {
    return this.runLease(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`recovery:${this.scope}`), (value) => {
          if (
            value !== undefined &&
            (!Number.isSafeInteger(value) || value < 0)
          )
            bad();
          result(value ?? 0);
        });
      }),
    );
  }
  finishRecovery(signal: AbortSignal): Promise<void> {
    return this.runLease(signal, (active) =>
      this.rootTransaction(active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`recovery:${this.scope}`), (through) => {
          if (through === undefined) {
            result(undefined);
            return;
          }
          if (!Number.isSafeInteger(through) || through < 0) bad();
          read(meta.get(`root:${this.scope}`), (raw) => {
            if (!raw || this.checkpoint(raw).serverSeq < through)
              throw new ProtocolError(
                "precondition_failed",
                "Snapshot recovery is incomplete",
              );
            meta.delete(`recovery:${this.scope}`);
            result(undefined);
          });
        });
      }),
    );
  }
  private checkpoint(value: unknown): BrowserCheckpoint {
    const parsed = snapshotDescriptorSchema.safeParse(value);
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
  private catalog(value: unknown): BrowserCheckpoint[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_SEEK_CHECKPOINTS) bad();
    const entries = value.map((item) => this.checkpoint(item));
    for (const [index, entry] of entries.entries()) {
      const previous = entries[index - 1];
      if (
        !entry.activity ||
        (previous &&
          (previous.serverSeq >= entry.serverSeq ||
            previous.timelineMs > entry.timelineMs))
      )
        bad();
    }
    return entries;
  }
  loadCheckpointBefore(
    time: number,
    through: number,
    signal: AbortSignal,
  ): Promise<BrowserCheckpoint | null> {
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      !Number.isSafeInteger(through) ||
      through < 0
    )
      return Promise.reject(new RangeError("Invalid seek checkpoint boundary"));
    return this.run(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`root:${this.scope}`), (raw) => {
          const head = raw === undefined ? null : this.checkpoint(raw);
          read(meta.get(`seek:${this.scope}`), (raw) => {
            const entries = this.catalog(raw);
            if (
              entries.length &&
              (!head ||
                entries.at(-1)!.serverSeq > head.serverSeq ||
                entries.at(-1)!.timelineMs > head.timelineMs)
            )
              bad();
            result(
              entries.findLast(
                (entry) =>
                  entry.serverSeq <= through && entry.timelineMs <= time,
              ) ?? null,
            );
          });
        });
      }),
    );
  }
  private async validateCheckpoint(
    next: BrowserCheckpoint,
    active: AbortSignal,
  ) {
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
  }
  /** Cache a reconstructed historical view without moving the receipt head. */
  saveSeekCheckpoint(
    input: BrowserCheckpoint,
    signal: AbortSignal,
  ): Promise<void> {
    const next = this.checkpoint(input);
    if (!next.activity)
      return Promise.reject(
        new ProtocolError(
          "precondition_failed",
          "Seek checkpoint requires activity order",
        ),
      );
    return this.run(signal, async (active) => {
      await this.validateCheckpoint(next, active);
      return this.rootTransaction(active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`root:${this.scope}`), (raw) => {
          const head = raw === undefined ? null : this.checkpoint(raw);
          if (
            !head ||
            next.serverSeq > head.serverSeq ||
            next.timelineMs > head.timelineMs
          )
            throw new ProtocolError(
              "precondition_failed",
              "Seek checkpoint exceeds receipt",
            );
          if (
            next.serverSeq === head.serverSeq &&
            canonicalJson(next) !== canonicalJson(head)
          )
            throw new ProtocolError(
              "event_conflict",
              "Seek checkpoint differs from receipt",
            );
          read(meta.get(`seek:${this.scope}`), (raw) => {
            const entries = this.catalog(raw);
            const last = entries.at(-1);
            if (
              last &&
              (last.serverSeq > head.serverSeq ||
                last.timelineMs > head.timelineMs)
            )
              bad();
            const existing = entries.find(
              (entry) => entry.serverSeq === next.serverSeq,
            );
            if (existing && canonicalJson(existing) !== canonicalJson(next))
              throw new ProtocolError(
                "event_conflict",
                "Seek checkpoint differs from saved prefix",
              );
            const retained = retainSeekCheckpoint(entries, next, true);
            // Check order after inserting an older reconstructed prefix.
            this.catalog(retained);
            meta.put(retained, `seek:${this.scope}`);
            result(undefined);
          });
        });
      });
    });
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
      await this.validateCheckpoint(next, active);
      return this.rootTransaction(active, (tx, read, result) => {
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
          if (!next.activity) {
            meta.put(next, key);
            result(next);
            return;
          }
          read(meta.get(`seek:${this.scope}`), (raw) => {
            const entries = this.catalog(raw);
            const last = entries.at(-1);
            if (
              last &&
              (!current ||
                last.serverSeq > current.serverSeq ||
                last.timelineMs > current.timelineMs)
            )
              bad();
            const retained = retainSeekCheckpoint(entries, next);
            meta.put(next, key);
            if (
              retained.length !== entries.length ||
              retained.at(-1) !== entries.at(-1)
            )
              meta.put(retained, `seek:${this.scope}`);
            result(next);
          });
        });
      });
    });
  }
  loadView(signal: AbortSignal): Promise<BrowserView | undefined> {
    return this.run(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`view:${this.scope}`), (raw) =>
          result(raw === undefined ? undefined : browserPresentation(raw)),
        );
      }),
    );
  }
  saveView(input: BrowserView, signal: AbortSignal): Promise<void> {
    const view = browserPresentation(input);
    return this.run(signal, (active) =>
      this.rootTransaction(active, (tx, read, result) => {
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
  loadAttachmentChoice(signal: AbortSignal) {
    return this.runLease(signal, (active) =>
      this.transaction<import("./attachments.js").Attachment | undefined>(
        "readonly",
        active,
        (tx, read, result) => {
          read(
            tx.objectStore("meta").get(`attachment-choice:${this.scope}`),
            (value) =>
              result(
                value === undefined ? undefined : attachmentSchema.parse(value),
              ),
          );
        },
      ),
    );
  }
  setAttachmentChoice(
    value: import("./attachments.js").Attachment | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const choice =
      value === undefined ? undefined : attachmentSchema.parse(value);
    return this.runLease(signal, (active) =>
      this.rootTransaction(active, (tx, _read, result) => {
        const meta = tx.objectStore("meta"),
          key = `attachment-choice:${this.scope}`;
        if (choice === undefined) meta.delete(key);
        else meta.put(choice, key);
        result(undefined);
      }),
    );
  }
  loadTextPages(signal: AbortSignal): Promise<TextPageChoice[]> {
    return this.runLease(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`text-pages:${this.scope}`), (value) =>
          result(textPageChoices(value)),
        );
      }),
    );
  }
  setTextPage(
    key: string,
    page: TextPosition,
    signal: AbortSignal,
  ): Promise<void> {
    key = expansionKey(key);
    page = textPosition(page);
    return this.runLease(signal, (active) =>
      this.rootTransaction(active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`text-pages:${this.scope}`), (value) => {
          meta.put(
            changeTextPage(textPageChoices(value), key, page),
            `text-pages:${this.scope}`,
          );
          result(undefined);
        });
      }),
    );
  }
  loadExpansions(signal: AbortSignal): Promise<string[]> {
    return this.runLease(signal, (active) =>
      this.transaction("readonly", active, (tx, read, result) => {
        read(tx.objectStore("meta").get(`expansions:${this.scope}`), (value) =>
          result(expansionChoices(value)),
        );
      }),
    );
  }
  setExpansion(
    key: string,
    expanded: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    key = expansionKey(key);
    return this.runLease(signal, (active) =>
      this.rootTransaction(active, (tx, read, result) => {
        const meta = tx.objectStore("meta");
        read(meta.get(`expansions:${this.scope}`), (value) => {
          meta.put(
            changeExpansion(expansionChoices(value), key, expanded),
            `expansions:${this.scope}`,
          );
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
      this.closing = Promise.all([this.tail, this.leaseTail]).then(() =>
        this.db.close(),
      );
    }
    return this.closing;
  }
}

export function browserPresentation(value: unknown): BrowserView {
  const v = value as BrowserView;
  if (
    !v ||
    typeof v !== "object" ||
    ![
      "mode,serverSeq,speed,timelineMs",
      "idleCapMs,mode,serverSeq,speed,timelineMs",
      "gapAnchorMs,mode,serverSeq,speed,timelineMs",
      "gapAnchorMs,idleCapMs,mode,serverSeq,speed,timelineMs",
    ].includes(Object.keys(v).sort().join(",")) ||
    ("idleCapMs" in v &&
      (typeof v.idleCapMs !== "number" ||
        !Number.isFinite(v.idleCapMs) ||
        v.idleCapMs < 0)) ||
    ("gapAnchorMs" in v &&
      (typeof v.gapAnchorMs !== "number" ||
        !Number.isFinite(v.gapAnchorMs) ||
        v.gapAnchorMs < 0 ||
        v.gapAnchorMs > v.timelineMs)) ||
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
