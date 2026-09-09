import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";
import { BlobStore, type BlobDescriptor } from "./blobs.js";
import { FileLock } from "./lock.js";
import { syncDirectory } from "./atomic.js";
export const CONTENT_PAGE_UNITS = 16384;
const MAX_PAGES = 4096;
const MAX_BLOB_BYTES = 1024 * 1024;
export interface TextReference extends BlobDescriptor {
  units: number;
}
interface Manifest {
  version: 1;
  units: number;
  pages: TextReference[];
}
function validReference(ref: TextReference, maximum: number) {
  if (
    !ref ||
    typeof ref !== "object" ||
    Object.keys(ref).sort().join(",") !== "byteSize,hash,units" ||
    typeof ref.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(ref.hash)
  )
    throw new ProtocolError("corrupt_storage", "Invalid content reference");
  if (
    !Number.isSafeInteger(ref.byteSize) ||
    ref.byteSize < 1 ||
    ref.byteSize > MAX_BLOB_BYTES ||
    !Number.isSafeInteger(ref.units) ||
    ref.units < 0 ||
    ref.units > maximum
  )
    throw new ProtocolError("corrupt_storage", "Invalid content reference");
}
function decode(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProtocolError("corrupt_storage", "Invalid content JSON");
  }
}
async function next<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return iterator.next();
      })
      .then(resolve, reject)
      .finally(cleanup);
  });
}
/** Rebuildable immutable text content, separate from attachment references and event durability. */
export class TextStore {
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
    validReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
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
    validReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
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
    signal = signal
      ? AbortSignal.any([signal, this.sourceStop.signal])
      : this.sourceStop.signal;
    return this.run(async () => {
      signal?.throwIfAborted();
      const input =
        typeof source === "string"
          ? (async function* () {
              for (
                let offset = 0;
                offset < source.length;
                offset += CONTENT_PAGE_UNITS
              )
                yield source.slice(offset, offset + CONTENT_PAGE_UNITS);
            })()
          : source;
      const iterator = input[Symbol.asyncIterator]();
      const pages: TextReference[] = [];
      let pending = "",
        units = 0,
        complete = false;
      let inputChunks = 0;
      const flush = async (text: string) => {
        if (pages.length >= MAX_PAGES)
          throw new ProtocolError(
            "invalid_request",
            "Text exceeds content page limit",
          );
        pages.push(await this.save(text, text.length, signal));
      };
      try {
        while (true) {
          if (++inputChunks % 256 === 0)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const item = await next(iterator, signal);
          if (item.done) {
            complete = true;
            break;
          }
          if (typeof item.value !== "string" || item.value.length > 65536)
            throw new ProtocolError(
              "invalid_request",
              "Content input chunks must be strings of at most 65536 units",
            );
          units += item.value.length;
          if (units > MAX_PAGES * CONTENT_PAGE_UNITS)
            throw new ProtocolError(
              "invalid_request",
              "Text exceeds content page limit",
            );
          pending += item.value;
          while (pending.length >= CONTENT_PAGE_UNITS) {
            await flush(pending.slice(0, CONTENT_PAGE_UNITS));
            pending = pending.slice(CONTENT_PAGE_UNITS);
          }
        }
        if (pending.length) await flush(pending);
        return await this.save(
          { version: 1, units, pages } satisfies Manifest,
          units,
          signal,
        );
      } finally {
        if (!complete && iterator.return)
          void Promise.resolve()
            .then(() => iterator.return!())
            .catch(() => {});
      }
    });
  }
  read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string> {
    // Copy caller-owned descriptors before asynchronous admission.
    ref = { ...ref };
    return this.run(async () => {
      validReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 65536 ||
        offset > ref.units ||
        length > ref.units - offset
      )
        throw new RangeError("Invalid content range");
      const manifest = decode(await this.load(ref, signal)) as Manifest;
      if (
        !manifest ||
        Object.keys(manifest).sort().join(",") !== "pages,units,version" ||
        manifest.version !== 1 ||
        manifest.units !== ref.units ||
        !Array.isArray(manifest.pages) ||
        manifest.pages.length !== Math.ceil(ref.units / CONTENT_PAGE_UNITS)
      )
        throw new ProtocolError("corrupt_storage", "Invalid text manifest");
      for (const [index, page] of manifest.pages.entries()) {
        validReference(page, CONTENT_PAGE_UNITS);
        if (
          page.units !==
          Math.min(CONTENT_PAGE_UNITS, ref.units - index * CONTENT_PAGE_UNITS)
        )
          throw new ProtocolError(
            "corrupt_storage",
            "Invalid text page length",
          );
      }
      let result = "";
      for (let position = offset; position < offset + length;) {
        signal?.throwIfAborted();
        const index = Math.floor(position / CONTENT_PAGE_UNITS);
        const page = manifest.pages[index]!;
        const text = decode(await this.load(page, signal));
        if (typeof text !== "string" || text.length !== page.units)
          throw new ProtocolError("corrupt_storage", "Invalid text page");
        const start = position % CONTENT_PAGE_UNITS;
        const count = Math.min(page.units - start, offset + length - position);
        result += text.slice(start, start + count);
        position += count;
      }
      signal?.throwIfAborted();
      return result;
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
