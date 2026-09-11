import { ProtocolError } from "./index.js";
export const CONTENT_PAGE_UNITS = 16384;
const MAX_PAGES = 4096;
const MAX_BLOB_BYTES = 1024 * 1024;
export interface TextReference {
  hash: string;
  byteSize: number;
  units: number;
}
interface Manifest {
  version: 1;
  units: number;
  pages: TextReference[];
}
export function validateTextReference(ref: TextReference, maximum: number) {
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
function decode(bytes: Uint8Array): unknown {
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

/** Backends verify bytes on load. Saved references become durable when flush completes; the codec flushes before returning them. */
export interface TextContentBackend {
  load(ref: TextReference, signal?: AbortSignal): Promise<Uint8Array>;
  save(
    value: unknown,
    units: number,
    signal?: AbortSignal,
  ): Promise<TextReference>;
  flush(signal?: AbortSignal): Promise<void>;
}
/** Portable immutable content codec. The caller owns admission and publication. */
export class TextContent {
  constructor(private readonly backend: TextContentBackend) {}
  put(
    source: string | AsyncIterable<string>,
    signal: AbortSignal,
  ): Promise<TextReference> {
    return this.write(source, signal);
  }
  async append(
    ref: TextReference,
    source: string | AsyncIterable<string>,
    signal: AbortSignal,
  ): Promise<TextReference> {
    ref = { ...ref };
    const manifest = await this.manifest(ref, signal);
    return this.write(source, signal, { ref, manifest });
  }
  private async write(
    source: string | AsyncIterable<string>,
    signal: AbortSignal,
    initial?: { ref: TextReference; manifest: Manifest },
  ): Promise<TextReference> {
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
    const pages: TextReference[] = initial ? [...initial.manifest.pages] : [];
    let pending = "",
      units = initial?.manifest.units ?? 0,
      complete = false;
    let inputChunks = 0,
      extended = false;
    const flush = async (text: string) => {
      if (pages.length >= MAX_PAGES)
        throw new ProtocolError(
          "invalid_request",
          "Text exceeds content page limit",
        );
      pages.push(await this.backend.save(text, text.length, signal));
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
        if (item.value.length && !extended) {
          extended = true;
          if (initial && initial.manifest.units % CONTENT_PAGE_UNITS) {
            const tail = pages.pop()!;
            pending = await this.page(tail, signal);
          }
        }
        pending += item.value;
        while (pending.length >= CONTENT_PAGE_UNITS) {
          await flush(pending.slice(0, CONTENT_PAGE_UNITS));
          pending = pending.slice(CONTENT_PAGE_UNITS);
        }
      }
      if (initial && !extended) {
        await this.backend.flush(signal);
        signal?.throwIfAborted();
        return initial.ref;
      }
      if (pending.length) await flush(pending);
      const result = await this.backend.save(
        { version: 1, units, pages } satisfies Manifest,
        units,
        signal,
      );
      await this.backend.flush(signal);
      signal?.throwIfAborted();
      return result;
    } finally {
      if (!complete && iterator.return)
        void Promise.resolve()
          .then(() => iterator.return!())
          .catch(() => {});
    }
  }
  private async manifest(
    ref: TextReference,
    signal?: AbortSignal,
  ): Promise<Manifest> {
    validateTextReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
    const manifest = decode(await this.backend.load(ref, signal)) as Manifest;
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
      validateTextReference(page, CONTENT_PAGE_UNITS);
      if (
        page.units !==
        Math.min(CONTENT_PAGE_UNITS, ref.units - index * CONTENT_PAGE_UNITS)
      )
        throw new ProtocolError("corrupt_storage", "Invalid text page length");
    }
    return manifest;
  }
  private async page(
    ref: TextReference,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = decode(await this.backend.load(ref, signal));
    if (typeof text !== "string" || text.length !== ref.units)
      throw new ProtocolError("corrupt_storage", "Invalid text page");
    return text;
  }
  /** Verify all codec dependencies before returning a complete retention set.
   * This does not trace references embedded in text or pin against collection.
   */
  async trace(
    ref: TextReference,
    signal?: AbortSignal,
  ): Promise<TextReference[]> {
    ref = { ...ref };
    signal?.throwIfAborted();
    const manifest = await this.manifest(ref, signal);
    const references = new Map<string, TextReference>([[ref.hash, ref]]);
    for (const page of manifest.pages) {
      signal?.throwIfAborted();
      const previous = references.get(page.hash);
      if (previous) {
        if (
          previous.byteSize !== page.byteSize ||
          previous.units !== page.units
        )
          throw new ProtocolError(
            "corrupt_storage",
            "Conflicting text blob references",
          );
        continue;
      }
      await this.page(page, signal);
      references.set(page.hash, { ...page });
    }
    signal?.throwIfAborted();
    return [...references.values()];
  }
  async read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string> {
    // Copy caller-owned descriptors before asynchronous admission.
    ref = { ...ref };
    validateTextReference(ref, MAX_PAGES * CONTENT_PAGE_UNITS);
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
    const manifest = await this.manifest(ref, signal);
    let result = "";
    for (let position = offset; position < offset + length;) {
      signal?.throwIfAborted();
      const index = Math.floor(position / CONTENT_PAGE_UNITS);
      const page = manifest.pages[index]!;
      const text = await this.page(page, signal);
      const start = position % CONTENT_PAGE_UNITS;
      const count = Math.min(page.units - start, offset + length - position);
      result += text.slice(start, start + count);
      position += count;
    }
    signal?.throwIfAborted();
    return result;
  }
}
