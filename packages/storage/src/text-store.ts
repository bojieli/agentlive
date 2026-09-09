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
import { BlobStore } from "./blobs.js";
import { FileLock } from "./lock.js";
import { syncDirectory } from "./atomic.js";
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
  ) {}
  static async open(directory: string, maxTotalBytes = 512 * 1024 * 1024) {
    const lock = await FileLock.acquire(join(directory, "content.lock"));
    try {
      return new TextStore(
        await BlobStore.open(join(directory, "pages"), {
          maxBlobBytes: MAX_BLOB_BYTES,
          maxTotalBytes,
          maxConcurrentUploads: 1,
        }),
        lock,
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
  private async load(
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
      await this.load(ref, signal);
      // A previous install may have linked the file before a directory flush failed.
      await syncDirectory(this.blobs.directory);
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
      await this.blobs.install(staged);
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
    return this.run(() => this.codec.read(ref, offset, length, signal));
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
