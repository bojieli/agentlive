import { TEXT_PAGE_SIZE } from "./text-page.js";
/** Identity must change whenever the referenced text changes. */
export interface TextSource {
  readonly key: string;
  readonly units: number;
  read(offset: number, length: number, signal: AbortSignal): Promise<string>;
}
function source(value: TextSource): TextSource {
  if (
    !value ||
    typeof value.key !== "string" ||
    !value.key.length ||
    value.key.length > 2048 ||
    !Number.isSafeInteger(value.units) ||
    value.units < 0 ||
    value.units > 67108864 ||
    typeof value.read !== "function"
  )
    throw new RangeError("Invalid text source");
  return { key: value.key, units: value.units, read: value.read.bind(value) };
}
async function read(
  value: TextSource,
  offset: number,
  length: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const text = await new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return value.read(offset, length, signal);
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  if (typeof text !== "string" || text.length !== length)
    throw new Error("Text source returned an invalid range");
  return text;
}
/** Verified, cancellable range access for bounded excerpts. */
export async function readSourceRange(
  input: TextSource,
  offset: number,
  length: number,
  signal: AbortSignal,
) {
  const value = source(input);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > 65536 ||
    offset + length > value.units
  )
    throw new RangeError("Invalid text range");
  return read(value, offset, length, signal);
}
/** One page plus at most two boundary units, never the whole retained text. */
export async function readTextPage(
  input: TextSource,
  requested: number,
  signal: AbortSignal,
) {
  const value = source(input);
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new RangeError("Invalid text page");
  const count = Math.max(1, Math.ceil(value.units / TEXT_PAGE_SIZE)),
    page = Math.min(requested, count - 1);
  let start = page * TEXT_PAGE_SIZE,
    end = Math.min(value.units, (page + 1) * TEXT_PAGE_SIZE);
  const from = Math.max(0, start - 1),
    through = Math.min(value.units, end + 1),
    text = await read(value, from, through - from, signal);
  const boundary = (position: number) => {
    const local = position - from;
    return local > 0 &&
      position < value.units &&
      text.charCodeAt(local - 1) >= 0xd800 &&
      text.charCodeAt(local - 1) <= 0xdbff &&
      text.charCodeAt(local) >= 0xdc00 &&
      text.charCodeAt(local) <= 0xdfff
      ? position - 1
      : position;
  };
  start = boundary(start);
  end = boundary(end);
  return {
    page,
    count,
    start,
    end,
    text: text.slice(start - from, end - from),
  };
}
export async function sourcePageContaining(
  input: TextSource,
  offset: number,
  signal: AbortSignal,
) {
  const value = source(input);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.units)
    throw new RangeError("Invalid text offset");
  const current = await readTextPage(
    value,
    Math.floor(offset / TEXT_PAGE_SIZE),
    signal,
  );
  return Math.min(
    current.count - 1,
    current.end <= offset ? current.page + 1 : current.page,
  );
}
/** Bounded literal search for text-page reveal; yields between groups of reads. */
export async function findSourceText(
  input: TextSource,
  query: string,
  signal: AbortSignal,
): Promise<number> {
  const value = source(input);
  if (!query.length || query.length > 256)
    throw new RangeError("Search requires 1–256 characters");
  signal.throwIfAborted();
  for (let offset = 0; offset < value.units; offset += TEXT_PAGE_SIZE) {
    if (offset && offset % (TEXT_PAGE_SIZE * 4) === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const text = await read(
        value,
        offset,
        Math.min(TEXT_PAGE_SIZE + query.length - 1, value.units - offset),
        signal,
      ),
      found = text.indexOf(query);
    if (found >= 0) return offset + found;
  }
  signal.throwIfAborted();
  return -1;
}
