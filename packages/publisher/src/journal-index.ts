import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  ProtocolError,
  type PublishedEvent,
} from "@agentlive/protocol";
import { syncDirectory } from "@agentlive/storage";

/** Placeholder stream identity for events journaled before the remote recording exists. */
export const UNBOUND_STREAM_ID = "unbound";
export const GENESIS_CHAIN = "0".repeat(64);
/** One fixed-width source-key index entry: key hash, first sequence, event count, content hash. */
export const KEY_ENTRY_BYTES = 44;
export const BLOOM_WORDS = 32768;
const BLOOM_BYTES = BLOOM_WORDS * 4;

export const segmentFile = (id: number) =>
  id === 0 ? "capture.jsonl" : `capture-${id}.jsonl`;
export const segmentKeysFile = (id: number) => `capture-${id}.keys`;
export const compactedKeysFile = (generation: number) =>
  `source-keys-${generation}.idx`;
export const MANIFEST_FILE = "journal.json";
export const BLOOM_FILE = "source-bloom.bin";

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sealedSchema = z.strictObject({
  records: count.min(1),
  bytes: count.min(1),
  hash: hex,
  lastSeq: count,
  chain: hex,
  keys: count,
  keysHash: hex,
  endsUnbound: z.boolean(),
});
const segmentSchema = z.strictObject({
  id: count,
  firstSeq: count.min(1),
  sealed: sealedSchema.optional(),
});
const compactedSchema = z.strictObject({
  throughSeq: count,
  chain: hex,
  generation: count.min(1),
  keys: count,
  keysHash: hex,
  adapterState: z.unknown(),
});
const manifestSchema = z.strictObject({
  version: z.literal(2),
  segments: z.array(segmentSchema).min(1).max(1_000_000),
  compacted: compactedSchema.nullable(),
});
export type SegmentMeta = z.infer<typeof segmentSchema>;
export type SealedMeta = z.infer<typeof sealedSchema>;
export type CompactedMeta = z.infer<typeof compactedSchema>;
export type JournalManifest = z.infer<typeof manifestSchema>;

/** Structural and continuity validation; file contents are checked when read. */
export function parseManifest(raw: unknown): JournalManifest {
  const parsed = manifestSchema.safeParse(raw);
  const invalid = () =>
    new ProtocolError("corrupt_storage", "Invalid publisher journal manifest");
  if (!parsed.success) throw invalid();
  const manifest = parsed.data;
  if (manifest.compacted)
    canonicalJson(manifest.compacted.adapterState ?? null);
  let expected = (manifest.compacted?.throughSeq ?? 0) + 1;
  let previousId = -1;
  manifest.segments.forEach((segment, index) => {
    const last = index === manifest.segments.length - 1;
    if (
      segment.id <= previousId ||
      segment.firstSeq !== expected ||
      Boolean(segment.sealed) === last ||
      (segment.sealed && segment.sealed.lastSeq < segment.firstSeq - 1)
    )
      throw invalid();
    previousId = segment.id;
    if (segment.sealed) expected = segment.sealed.lastSeq + 1;
  });
  return manifest;
}

/** Digest of a publisher event independent of its remote stream binding. */
export function publisherEventDigest(event: PublishedEvent): string {
  const { streamId: _, ...rest } = event;
  return sha256(canonicalJson(rest)).toString("hex");
}
/** Running hash over every captured event in producer order. */
export function advancePublisherChain(
  chain: string,
  event: PublishedEvent,
): string {
  return sha256(chain + publisherEventDigest(event)).toString("hex");
}
export const sourceKeyHash = (sourceKey: string) =>
  sha256(sourceKey).subarray(0, 16);
export const contentHash = (content: readonly unknown[]) =>
  sha256(canonicalJson(content)).subarray(0, 16);

export interface KeyEntry {
  key: Buffer;
  firstSeq: number;
  count: number;
  content: Buffer;
}
export function encodeKeys(entries: readonly KeyEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.key, b.key));
  const bytes = Buffer.alloc(sorted.length * KEY_ENTRY_BYTES);
  sorted.forEach((entry, index) => {
    const offset = index * KEY_ENTRY_BYTES;
    entry.key.copy(bytes, offset, 0, 16);
    bytes.writeBigUInt64BE(BigInt(entry.firstSeq), offset + 16);
    bytes.writeUInt32BE(entry.count, offset + 24);
    entry.content.copy(bytes, offset + 28, 0, 16);
  });
  return bytes;
}
export function decodeKey(bytes: Buffer, offset = 0): KeyEntry {
  const firstSeq = Number(bytes.readBigUInt64BE(offset + 16));
  if (!Number.isSafeInteger(firstSeq))
    throw new ProtocolError("corrupt_storage", "Invalid source-key index");
  return {
    key: Buffer.from(bytes.subarray(offset, offset + 16)),
    firstSeq,
    count: bytes.readUInt32BE(offset + 24),
    content: Buffer.from(bytes.subarray(offset + 28, offset + 44)),
  };
}
export const keysDigest = (bytes: Uint8Array) => sha256(bytes).toString("hex");

/**
 * Sealed key files are immutable, so their checksum is verified once per file and
 * then trusted for the life of the process. Without this a binary search could
 * read a bit-rotted entry — same size, so no length check catches it — and miss a
 * dedup, capturing one source record twice. Verification is per file, not per
 * lookup, and the source bloom filter keeps most lookups from reaching a file at
 * all. A file that fails stays failed for every later lookup.
 */
export class VerifiedKeyIndexes {
  private readonly checked = new Map<string, Promise<void>>();
  async search(
    path: string,
    entries: number,
    expectedHash: string,
    key: Buffer,
  ): Promise<KeyEntry | undefined> {
    if (!entries) return undefined;
    const cacheKey = `${expectedHash}\u0000${path}`;
    let check = this.checked.get(cacheKey);
    if (!check) {
      check = (async () => {
        for await (const _ of readKeys(path, entries, expectedHash)) void _;
      })();
      check.catch(() => {}); // The awaiting caller reports it.
      this.checked.set(cacheKey, check);
    }
    await check;
    return searchKeys(path, entries, key);
  }
}

/** Binary search in an immutable sorted key file without loading it. */
export async function searchKeys(
  path: string,
  entries: number,
  key: Buffer,
): Promise<KeyEntry | undefined> {
  if (!entries) return undefined;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(KEY_ENTRY_BYTES);
    let low = 0,
      high = entries - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const { bytesRead } = await file.read(
        buffer,
        0,
        KEY_ENTRY_BYTES,
        middle * KEY_ENTRY_BYTES,
      );
      if (bytesRead !== KEY_ENTRY_BYTES)
        throw new ProtocolError(
          "corrupt_storage",
          "Source-key index is shorter than its manifest",
        );
      const order = Buffer.compare(buffer.subarray(0, 16), key);
      if (order === 0) return decodeKey(buffer);
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/** Stream verified entries of an immutable key file in sorted order. */
export async function* readKeys(
  path: string,
  entries: number,
  expectedHash: string,
): AsyncGenerator<Buffer> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    const chunk = Buffer.alloc(KEY_ENTRY_BYTES * 4096);
    let offset = 0;
    const total = entries * KEY_ENTRY_BYTES;
    while (offset < total) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, total - offset),
        offset,
      );
      if (!bytesRead || bytesRead % KEY_ENTRY_BYTES)
        throw new ProtocolError(
          "corrupt_storage",
          "Source-key index is shorter than its manifest",
        );
      offset += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      for (let at = 0; at < bytes.length; at += KEY_ENTRY_BYTES)
        yield Buffer.from(bytes.subarray(at, at + KEY_ENTRY_BYTES));
    }
    if ((await file.stat()).size !== total)
      throw new ProtocolError(
        "corrupt_storage",
        "Source-key index size differs from its manifest",
      );
  } finally {
    await file.close();
  }
  if (hash.digest("hex") !== expectedHash)
    throw new ProtocolError(
      "corrupt_storage",
      "Source-key index checksum mismatch",
    );
}

/** Crash-safe replacement: temporary file, fsync, rename, directory fsync. */
export async function atomicBytes(
  path: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    for await (const chunk of chunks) {
      let written = 0;
      while (written < chunk.byteLength) {
        const { bytesWritten } = await file.write(
          chunk,
          written,
          chunk.byteLength - written,
        );
        if (!bytesWritten) throw new Error("Zero-byte journal index write");
        written += bytesWritten;
      }
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Merge sorted fresh entries into a sorted base file; earlier entries win on duplicates. */
export async function* mergeKeys(
  base: AsyncIterable<Buffer>,
  fresh: readonly Buffer[],
): AsyncGenerator<Buffer> {
  let index = 0;
  let last: Buffer | undefined;
  const emit = function* (entry: Buffer) {
    if (
      last &&
      Buffer.compare(last.subarray(0, 16), entry.subarray(0, 16)) === 0
    )
      return;
    last = entry;
    yield entry;
  };
  for await (const entry of base) {
    while (
      index < fresh.length &&
      Buffer.compare(fresh[index]!.subarray(0, 16), entry.subarray(0, 16)) < 0
    )
      yield* emit(fresh[index++]!);
    yield* emit(entry);
  }
  while (index < fresh.length) yield* emit(fresh[index++]!);
}

export function bloomBits(key: Buffer): number[] {
  return [0, 4, 8, 12].map(
    (offset) => key.readUInt32LE(offset) % (BLOOM_WORDS * 32),
  );
}
export function encodeBloom(words: Uint32Array): Buffer {
  const bits = Buffer.alloc(BLOOM_BYTES);
  for (let index = 0; index < BLOOM_WORDS; index++)
    bits.writeUInt32LE(words[index] ?? 0, index * 4);
  return Buffer.concat([bits, sha256(bits)]);
}
export function decodeBloom(bytes: Buffer, words: Uint32Array): boolean {
  if (bytes.length !== BLOOM_BYTES + 32) return false;
  const bits = bytes.subarray(0, BLOOM_BYTES);
  if (!sha256(bits).equals(bytes.subarray(BLOOM_BYTES))) return false;
  for (let index = 0; index < BLOOM_WORDS; index++)
    words[index] = bits.readUInt32LE(index * 4);
  return true;
}
