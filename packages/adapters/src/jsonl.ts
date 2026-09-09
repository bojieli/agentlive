import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
export interface SourceCursor {
  offset: number;
  prefixHash: string;
}
export interface SourceRecord {
  value: unknown;
  cursor: SourceCursor;
}
export interface SourceReadOptions {
  after?: SourceCursor;
  through?: number;
  /** Defer an incomplete live suffix, or parse a valid final line in a closed export. */
  tail?: "defer" | "parse";
  maxRecordBytes?: number;
  signal?: AbortSignal;
}
/** Read a frozen source-file prefix with bounded framing and verifiable resume cursors. */
export async function* readJsonlSource(
  path: string,
  options: SourceReadOptions = {},
): AsyncGenerator<SourceRecord> {
  const maximum = options.maxRecordBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError("Invalid source record limit");
  const after = options.after?.offset ?? 0;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new RangeError("Invalid source offset");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || after > info.size)
      throw new Error("Source was truncated or is not a regular file");
    const through = options.through ?? info.size;
    if (
      !Number.isSafeInteger(through) ||
      through < after ||
      through > info.size
    )
      throw new Error("Invalid frozen source boundary");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < after) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, after - position),
        position,
      );
      if (!bytesRead)
        throw new Error("Source changed during prefix validation");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (options.after && hash.copy().digest("hex") !== options.after.prefixHash)
      throw new Error(
        "Source prefix changed; explicit reconciliation is required",
      );
    // Prefix-only verification may end at a parsed closed-file suffix. Reading new records must start after LF.
    if (after && after < through) {
      const previous = Buffer.alloc(1);
      await file.read(previous, 0, 1, after - 1);
      if (previous[0] !== 10)
        throw new Error("Source cursor is not at a complete-line boundary");
    }
    let pending = Buffer.alloc(0),
      recordEnd = after;
    const parse = (bytes: Buffer) =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    while (position < through) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, through - position),
        position,
      );
      if (!bytesRead) throw new Error("Source truncated during snapshot read");
      let start = 0;
      for (let i = 0; i < bytesRead; i++)
        if (buffer[i] === 10) {
          if (pending.length + i - start > maximum)
            throw new Error("Source JSONL record exceeds limit");
          const line = Buffer.concat([pending, buffer.subarray(start, i)]);
          hash.update(buffer.subarray(start, i + 1));
          recordEnd = position + i + 1;
          const cursor = {
            offset: recordEnd,
            prefixHash: hash.copy().digest("hex"),
          };
          pending = Buffer.alloc(0);
          start = i + 1;
          if (line.length) yield { value: parse(line), cursor };
        }
      if (pending.length + bytesRead - start > maximum)
        throw new Error("Source JSONL record exceeds limit");
      if (start < bytesRead) {
        const tail = buffer.subarray(start, bytesRead);
        pending = Buffer.concat([pending, tail]);
        hash.update(tail);
      }
      position += bytesRead;
    }
    if (pending.length && options.tail === "parse")
      yield {
        value: parse(pending),
        cursor: { offset: through, prefixHash: hash.copy().digest("hex") },
      };
  } finally {
    await file.close();
  }
}
