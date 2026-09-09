import {
  TextContent,
  canonicalJson,
  validateTextReference,
  idSchema,
  ProtocolError,
  type TextReference,
} from "@agentlive/protocol";
import type { CacheBinding } from "./history-cache.js";
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
          resolve(new BrowserContentStore(request.result, scope, maxBytes));
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
