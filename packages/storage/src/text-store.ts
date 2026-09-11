import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJson,
  ProtocolError,
  TextContent,
  CONTENT_PAGE_UNITS,
  validateTextReference,
  type TextReference,
} from "@agentlive/protocol";
export { CONTENT_PAGE_UNITS, type TextReference } from "@agentlive/protocol";
const MAX_PAGES = 4096,
  MAX_BLOB_BYTES = 1024 * 1024;
import { ContentMarks } from "./content-marks.js";
import { BlobStore } from "./blobs.js";
import { FileLock } from "./lock.js";
import { syncDirectory } from "./atomic.js";
export type TextBlobLoader = (
  ref: TextReference,
  signal: AbortSignal,
) => Promise<Uint8Array>;
export interface ContentCollectionTrace {
  read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Retain a complete text manifest and its validated pages. */
  retain(ref: TextReference): Promise<void>;
  /** Retain an exact raw blob, for active raw-blob read pins. */
  retainBlob(ref: TextReference): Promise<void>;
}
/** Rebuildable immutable text content, separate from attachment references and event durability. */
export class TextStore {
  private readonly codec = new TextContent({
    load: (ref, signal) => this.load(ref, signal),
    save: (value, units, signal) => this.save(value, units, signal),
    flush: async (signal) => {
      await syncDirectory(this.blobs.directory);
      signal?.throwIfAborted();
    },
  });
  private tail: Promise<void> = Promise.resolve();
  private readonly sourceStop = new AbortController();
  private pending = 0;
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly blobs: BlobStore,
    private readonly lock: FileLock,
    private readonly loader?: TextBlobLoader,
  ) {}
  static async open(
    directory: string,
    maxTotalBytes = 512 * 1024 * 1024,
    loader?: TextBlobLoader,
  ) {
    const lock = await FileLock.acquire(join(directory, "content.lock"));
    try {
      // The exclusive store lock proves no mark attempt in this directory is live.
      // Marks are never reused: root/publication state may have changed after a crash.
      await rm(join(directory, "collection"), { recursive: true, force: true });
      await syncDirectory(directory);
      return new TextStore(
        await BlobStore.open(join(directory, "pages"), {
          maxBlobBytes: MAX_BLOB_BYTES,
          maxTotalBytes,
          maxConcurrentUploads: 1,
        }),
        lock,
        loader,
      );
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  get usage() {
    return this.blobs.usage;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("storage_failed", "Content store is closing"),
      );
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Content operation queue is full"),
      );
    this.pending++;
    const task = this.tail.then(operation).finally(() => {
      this.pending--;
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async loadLocal(
    ref: TextReference,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    validateTextReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
    signal?.throwIfAborted();
    const file = await this.blobs.openFile(ref.hash);
    try {
      if ((await file.stat()).size !== ref.byteSize)
        throw new ProtocolError("corrupt_storage", "Content size changed");
      const bytes = Buffer.alloc(ref.byteSize);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead)
          throw new ProtocolError("corrupt_storage", "Content ended early");
        offset += bytesRead;
      }
      if (
        (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead ||
        createHash("sha256").update(bytes).digest("hex") !== ref.hash
      )
        throw new ProtocolError("corrupt_storage", "Content checksum changed");
      signal?.throwIfAborted();
      return bytes;
    } finally {
      await file.close();
    }
  }
  private async load(
    ref: TextReference,
    parent?: AbortSignal,
  ): Promise<Buffer> {
    try {
      return await this.loadLocal(ref, parent);
    } catch (error) {
      if (
        !this.loader ||
        !(error instanceof ProtocolError) ||
        error.code !== "precondition_failed"
      )
        throw error;
    }
    const signal = AbortSignal.any([
      this.sourceStop.signal,
      AbortSignal.timeout(10000),
      ...(parent ? [parent] : []),
    ]);
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
      throw new ProtocolError(
        "corrupt_storage",
        "Downloaded content size differs",
      );
    const bytes = Buffer.from(remote);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.hash)
      throw new ProtocolError(
        "corrupt_storage",
        "Downloaded content checksum differs",
      );
    const staged = await this.blobs.stage(
      ref,
      (async function* () {
        yield bytes;
      })(),
      signal,
    );
    try {
      signal.throwIfAborted();
      await this.blobs.install(staged);
      signal.throwIfAborted();
      return bytes;
    } finally {
      await this.blobs.discard(staged);
    }
  }
  private async save(
    value: unknown,
    units: number,
    signal?: AbortSignal,
  ): Promise<TextReference> {
    signal?.throwIfAborted();
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const ref = {
      hash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      units,
    };
    validateTextReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
    try {
      await this.loadLocal(ref, signal);
      // The enclosing codec operation flushes the directory, including a prior uncertain install.
      return ref;
    } catch (error) {
      if (
        !(error instanceof ProtocolError) ||
        error.code !== "precondition_failed"
      )
        throw error;
    }
    const staged = await this.blobs.stage(
      ref,
      (async function* () {
        yield bytes;
      })(),
      signal,
    );
    try {
      signal?.throwIfAborted();
      await this.blobs.install(staged, { deferDirectorySync: true });
      return ref;
    } finally {
      await this.blobs.discard(staged);
    }
  }
  put(
    source: string | AsyncIterable<string>,
    signal?: AbortSignal,
  ): Promise<TextReference> {
    const combined = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(() => this.codec.put(source, combined));
  }
  /** Reuse completed pages and rewrite only a partial tail plus new content. */
  append(
    ref: TextReference,
    source: string | AsyncIterable<string>,
    signal?: AbortSignal,
  ): Promise<TextReference> {
    ref = { ...ref };
    const combined = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(() => this.codec.append(ref, source, combined));
  }
  read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string> {
    ref = { ...ref };
    const active = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(() => this.codec.read(ref, offset, length, active));
  }
  /** Complete verified manifest/page set; caller must pin retained roots before any collection. */
  trace(ref: TextReference, signal?: AbortSignal): Promise<TextReference[]> {
    ref = { ...ref };
    const active = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(() => this.codec.trace(ref, active));
  }
  /** Exact immutable codec bytes, verified against their content address. */
  readBlob(ref: TextReference, signal?: AbortSignal): Promise<Buffer> {
    ref = { ...ref };
    const active = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(() => this.load(ref, active));
  }
  /** Exclusive local mark/seal/sweep. Caller must freeze publication and retain all live roots.
   * Use only the scoped reader in trace: calling this store's queued methods would deadlock.
   * A failed/cancelled trace never starts sweeping; partial sweep is safe only for complete marks.
   */
  collect(
    trace: (
      content: ContentCollectionTrace,
      signal: AbortSignal,
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ removed: number; reclaimedBytes: number }> {
    const active = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(async () => {
      active.throwIfAborted();
      const marks = await ContentMarks.create(
        join(this.blobs.directory, "..", "collection"),
      );
      let accepting = true,
        failure: unknown,
        failed = false;
      let tail: Promise<void> = Promise.resolve();
      let pending = 0;
      const admit = <T>(operation: () => Promise<T>): Promise<T> => {
        if (!accepting || pending >= 16) {
          const error = new ProtocolError(
            "precondition_failed",
            "Collection trace scope is closed or full",
          );
          if (accepting) {
            failed = true;
            failure = error;
          }
          return Promise.reject(error);
        }
        pending++;
        const task = tail.then(async () => {
          active.throwIfAborted();
          return operation();
        });
        tail = task
          .then(
            () => {},
            (error) => {
              failed = true;
              failure = error;
            },
          )
          .finally(() => {
            pending--;
          });
        return task;
      };
      // Bounded attempt-local cache for repeated metadata reads across retained roots.
      const readCache = new Map<string, string>();
      let cachedUnits = 0;
      const scoped: ContentCollectionTrace = {
        read: (reference, offset, length, signal) => {
          const ref = { ...reference };
          return admit(async () => {
            const combined = signal
              ? AbortSignal.any([active, signal])
              : active;
            combined.throwIfAborted();
            const key = canonicalJson({ ref, offset, length });
            const cached = readCache.get(key);
            if (cached !== undefined) {
              readCache.delete(key);
              readCache.set(key, cached);
              return cached;
            }
            const text = await this.codec.read(ref, offset, length, combined);
            while (
              readCache.size &&
              (readCache.size >= 128 || cachedUnits + text.length > 1048576)
            ) {
              const oldest = readCache.keys().next().value!;
              cachedUnits -= readCache.get(oldest)!.length;
              readCache.delete(oldest);
            }
            readCache.set(key, text);
            cachedUnits += text.length;
            return text;
          });
        },
        retain: (reference) => {
          const ref = { ...reference };
          return admit(async () => {
            if (marks.traced(ref, active)) return;
            for (const blob of await this.codec.trace(ref, active))
              marks.add(blob.hash, active);
            marks.recordTrace(ref, active);
          });
        },
        retainBlob: (reference) => {
          const ref = { ...reference };
          return admit(async () => {
            await this.load(ref, active);
            marks.add(ref.hash, active);
          });
        },
      };
      try {
        try {
          await trace(scoped, active);
        } catch (error) {
          failed = true;
          failure = error;
        }
        accepting = false;
        await tail;
        if (failed) throw failure;
        active.throwIfAborted();
        await marks.seal(active);
        const before = this.blobs.usage.storedBytes;
        const removed = await this.blobs.collectMarked(
          async (hash) => marks.has(hash, active),
          Number.MAX_VALUE,
          active,
        );
        return {
          removed,
          reclaimedBytes: before - this.blobs.usage.storedBytes,
        };
      } finally {
        accepting = false;
        await tail;
        readCache.clear();
        await marks.close();
      }
    });
  }
  close(): Promise<void> {
    this.closing ??= this.tail.then(async () => {
      try {
        await this.blobs.close();
      } finally {
        await this.lock.release();
      }
    });
    this.sourceStop.abort(new Error("Content store is closing"));
    return this.closing;
  }
}
