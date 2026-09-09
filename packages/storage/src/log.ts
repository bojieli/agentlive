import { open, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";
import { syncDirectory } from "./atomic.js";
import { FileLock } from "./lock.js";

export type LogEntry<T> = Readonly<{
  sequence: number;
  previousHash: string;
  hash: string;
  value: T;
}>;
export type LogBoundary = Readonly<{
  sequence: number;
  byteOffset: number;
  hash: string;
}>;
interface IndexEntry {
  sequence: number;
  byteOffset: number;
  previousHash: string;
}
export interface LogOptions<T> {
  parse: (input: unknown) => T;
  maxRecordBytes?: number;
  indexStride?: number;
}
const GENESIS = "0".repeat(64);
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** One owner, serialized durable appends, concurrent readers of a frozen prefix. */
export class JsonlLog<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private committed: LogBoundary = {
    sequence: 0,
    byteOffset: 0,
    hash: GENESIS,
  };
  private index: IndexEntry[] = [];
  private failed = false;
  private closed = false;
  private constructor(
    private readonly file: FileHandle,
    readonly path: string,
    private readonly options: Required<LogOptions<T>>,
    private readonly lock: FileLock,
  ) {}

  static async open<T>(
    path: string,
    options: LogOptions<T>,
  ): Promise<JsonlLog<T>> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await FileLock.acquire(path + ".lock");
    let file: FileHandle;
    try {
      file = await open(path, "a+", 0o600);
    } catch (error) {
      await lock.release();
      throw error;
    }
    try {
      await syncDirectory(dirname(path));
      const log = new JsonlLog(
        file,
        path,
        {
          ...options,
          maxRecordBytes: options.maxRecordBytes ?? 2 * 1024 * 1024,
          indexStride: options.indexStride ?? 128,
        },
        lock,
      );
      if (
        !Number.isSafeInteger(log.options.indexStride) ||
        log.options.indexStride < 1
      )
        throw new RangeError("Invalid index stride");
      if (
        !Number.isSafeInteger(log.options.maxRecordBytes) ||
        log.options.maxRecordBytes < 128
      )
        throw new RangeError("Invalid record byte limit");
      await log.recover();
      return log;
    } catch (error) {
      await file.close();
      await lock.release();
      throw error;
    }
  }

  get boundary(): LogBoundary {
    return { ...this.committed };
  }

  private async *lines(
    start: number,
    end: number,
  ): AsyncGenerator<{ bytes: Buffer; end: number }> {
    let offset = start;
    let pending = Buffer.alloc(0);
    const chunk = Buffer.alloc(
      Math.min(64 * 1024, this.options.maxRecordBytes),
    );
    while (offset < end) {
      const { bytesRead } = await this.file.read(
        chunk,
        0,
        Math.min(chunk.length, end - offset),
        offset,
      );
      if (!bytesRead)
        throw new ProtocolError(
          "corrupt_storage",
          "Recording is shorter than its committed boundary",
        );
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let split: number;
      while ((split = pending.indexOf(10)) !== -1) {
        if (split + 1 > this.options.maxRecordBytes)
          throw new ProtocolError(
            "corrupt_storage",
            "Recording line exceeds configured limit",
          );
        yield {
          bytes: pending.subarray(0, split),
          end: offset - pending.length + split + 1,
        };
        pending = pending.subarray(split + 1);
      }
      if (pending.length >= this.options.maxRecordBytes)
        throw new ProtocolError(
          "corrupt_storage",
          "Unterminated recording line exceeds configured limit",
        );
    }
    // A final incomplete line is only truncated by recover(), never exposed to readers.
  }

  private decode(
    bytes: Buffer,
    sequence: number,
    previousHash: string,
  ): LogEntry<T> {
    try {
      const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as Record<string, unknown>;
      if (
        Object.keys(raw).sort().join(",") !== "hash,previousHash,sequence,value"
      )
        throw new Error("Unexpected record fields");
      if (
        raw.sequence !== sequence ||
        raw.previousHash !== previousHash ||
        typeof raw.hash !== "string"
      )
        throw new Error("Broken sequence or hash chain");
      if (raw.hash !== digest({ sequence, previousHash, value: raw.value }))
        throw new Error("Checksum mismatch");
      const value = this.options.parse(raw.value);
      return { sequence, previousHash, hash: raw.hash, value };
    } catch (cause) {
      throw new ProtocolError(
        "corrupt_storage",
        `Invalid complete recording record at sequence ${sequence}`,
        { sequence },
      );
    }
  }

  private async recover(): Promise<void> {
    const size = (await this.file.stat()).size;
    for await (const line of this.lines(0, size)) {
      const record = this.decode(
        line.bytes,
        this.committed.sequence + 1,
        this.committed.hash,
      );
      this.addIndex(
        record.sequence,
        this.committed.byteOffset,
        record.previousHash,
      );
      this.committed = {
        sequence: record.sequence,
        byteOffset: line.end,
        hash: record.hash,
      };
    }
    if (size !== this.committed.byteOffset) {
      await this.file.truncate(this.committed.byteOffset);
      await this.file.sync();
    }
  }

  private addIndex(
    sequence: number,
    byteOffset: number,
    previousHash: string,
  ): void {
    if ((sequence - 1) % this.options.indexStride === 0)
      this.index.push({ sequence, byteOffset, previousHash });
  }

  append(values: readonly T[]): Promise<readonly LogEntry<T>[]> {
    // Freeze inputs before joining the queue; caller mutation cannot change retry identity.
    let copied: T[];
    try {
      copied = values.map((value) =>
        this.options.parse(JSON.parse(canonicalJson(value))),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.tail.then(async () => {
      if (this.closed || this.failed)
        throw new ProtocolError(
          "storage_failed",
          "Recording writer requires recovery",
        );
      if (copied.length === 0) return [];
      if (this.committed.sequence + copied.length > Number.MAX_SAFE_INTEGER)
        throw new RangeError("Sequence exhausted");
      let sequence = this.committed.sequence;
      let previousHash = this.committed.hash;
      const records: LogEntry<T>[] = [];
      const lines: Buffer[] = [];
      for (const value of copied) {
        const body = { sequence: ++sequence, previousHash, value };
        const record = { ...body, hash: digest(body) };
        const line = Buffer.from(canonicalJson(record) + "\n");
        if (line.length > this.options.maxRecordBytes)
          throw new RangeError("Event exceeds recording line limit");
        records.push(record);
        lines.push(line);
        previousHash = record.hash;
      }
      const bytes = Buffer.concat(lines);
      try {
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await this.file.write(
            bytes,
            written,
            bytes.length - written,
            null,
          );
          if (!bytesWritten) throw new Error("Zero-byte append");
          written += bytesWritten;
        }
        await this.file.sync();
      } catch (error) {
        this.failed = true;
        throw error;
      }
      let offset = this.committed.byteOffset;
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        this.addIndex(record.sequence, offset, record.previousHash);
        offset += lines[i]!.length;
      }
      this.committed = { sequence, byteOffset: offset, hash: previousHash };
      return records;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async *read(
    after = 0,
    through = this.committed.sequence,
  ): AsyncGenerator<LogEntry<T>> {
    if (
      !Number.isSafeInteger(after) ||
      !Number.isSafeInteger(through) ||
      after < 0 ||
      through < after ||
      through > this.committed.sequence
    ) {
      throw new ProtocolError("cursor_invalid", "Invalid recording cursor", {
        highWater: this.committed.sequence,
      });
    }
    if (this.closed)
      throw new ProtocolError("storage_failed", "Recording is closed");
    if (after === through) return;
    const boundary = this.committed;
    const start = this.index[Math.floor(after / this.options.indexStride)];
    if (!start)
      throw new ProtocolError("corrupt_storage", "Missing recording index");
    let sequence = start.sequence;
    let previousHash = start.previousHash;
    for await (const line of this.lines(
      start.byteOffset,
      boundary.byteOffset,
    )) {
      const record = this.decode(line.bytes, sequence++, previousHash);
      previousHash = record.hash;
      if (record.sequence > after) yield record;
      if (record.sequence === through) return;
    }
    throw new ProtocolError(
      "corrupt_storage",
      "Recording ended before the requested cursor",
    );
  }

  async close(): Promise<void> {
    // Enqueue closing so accepted writes complete; future writes observe closed=true.
    const close = this.tail.then(async () => {
      if (!this.closed) {
        this.closed = true;
        try {
          await this.file.close();
        } finally {
          await this.lock.release();
        }
      }
    });
    this.tail = close.catch(() => {});
    return close;
  }
}
