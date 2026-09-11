import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  link,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";
import {
  archiveManifestSchema,
  canonicalJson,
  reduceCompletenessNotice,
  storedEventSchema,
  type ArchiveManifest,
  type ReducedCompletenessNotice,
  type StoredEvent,
} from "@agentlive/protocol";
import { syncDirectory } from "./atomic.js";

const MAX_TOTAL = 8 * 1024 ** 3;
const MAX_MANIFEST = 16 * 1024 ** 2;
const MAX_EVENT = 1024 ** 2;
const MAX_ATTACHMENT = 64 * 1024 ** 2;
const MAX_FILES = 100001;
const allowed = /^(manifest\.json|events\.jsonl|attachments\/[a-f0-9]{64})$/;
function invalid(message: string): never {
  throw new Error(`Invalid AgentLive archive: ${message}`);
}
export type ArchiveMetadata = Omit<ArchiveManifest, "files">;
export interface OpenArchive {
  readonly manifest: ArchiveManifest;
  events(signal?: AbortSignal): AsyncGenerator<StoredEvent>;
  attachment(hash: string): Readable;
  close(): Promise<void>;
}

/** Canonical event stream; framing is bounded even for hostile files without newlines. */
async function* eventsAt(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<StoredEvent> {
  signal?.throwIfAborted();
  let remainder = Buffer.alloc(0);
  const input = createReadStream(path, {
    highWaterMark: 65536,
    ...(signal ? { signal } : {}),
  });
  try {
    for await (const raw of input) {
      signal?.throwIfAborted();
      const chunk = Buffer.concat([remainder, raw as Buffer]);
      let start = 0,
        end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        if (end - start > MAX_EVENT || end === start)
          invalid("event line size");
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          chunk.subarray(start, end),
        );
        signal?.throwIfAborted();
        yield storedEventSchema.parse(JSON.parse(line));
        start = end + 1;
      }
      remainder = Buffer.from(chunk.subarray(start));
      if (remainder.length > MAX_EVENT) invalid("event line size");
    }
    if (remainder.length) invalid("unterminated event line");
  } catch (error) {
    // Node file streams wrap cancellation in AbortError. Callers use the
    // original reason to distinguish navigation from a failed archive read.
    signal?.throwIfAborted();
    throw error;
  }
}
async function hashFile(path: string, maximum: number, signal?: AbortSignal) {
  let byteSize = 0;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, {
    ...(signal ? { signal } : {}),
  })) {
    byteSize += chunk.length;
    if (byteSize > maximum) invalid("file size limit");
    hash.update(chunk);
  }
  return { byteSize, hash: hash.digest("hex") };
}
async function verify(
  directory: string,
  manifest: ArchiveManifest,
  signal?: AbortSignal,
) {
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    if (paths.has(file.path)) invalid("duplicate manifest path");
    paths.add(file.path);
    total += file.byteSize;
    if (total > MAX_TOTAL) invalid("expanded size limit");
    const actual = await hashFile(
      join(directory, file.path),
      file.path === "events.jsonl" ? MAX_TOTAL : MAX_ATTACHMENT,
      signal,
    );
    if (actual.byteSize !== file.byteSize || actual.hash !== file.hash)
      invalid("file hash or size mismatch");
    if (
      file.path.startsWith("attachments/") &&
      file.path !== `attachments/${file.hash}`
    )
      invalid("attachment path hash mismatch");
  }
  if (!paths.has("events.jsonl")) invalid("missing event stream");
  const attachments = new Map<string, number>();
  let through = 0,
    timeline = 0,
    gaps = 0,
    notice: ReducedCompletenessNotice | undefined;
  let lifecycle: "open" | "ended" = "open";
  for await (const event of eventsAt(join(directory, "events.jsonl"), signal)) {
    if (event.serverSeq !== ++through || event.timelineMs < timeline)
      invalid("event order");
    if (through > manifest.recording.throughServerSeq)
      invalid("events exceed frozen prefix");
    timeline = event.timelineMs;
    if (event.content.kind === "recording.ended") lifecycle = "ended";
    else if (
      event.content.kind === "recording.created" ||
      event.content.kind === "recording.reopened"
    )
      lifecycle = "open";
    if (event.origin.type === "publisher") {
      const published = event.origin.event;
      if (
        published.streamId !== manifest.recording.streamId ||
        createHash("sha256").update(canonicalJson(published)).digest("hex") !==
          event.origin.digest ||
        canonicalJson(published.content) !== canonicalJson(event.content)
      )
        invalid("publisher provenance mismatch");
    }
    if (event.content.kind === "capture.gap") gaps++;
    notice = reduceCompletenessNotice(notice, event);
    if (event.content.kind === "attachment.available") {
      const attachment = event.content.payload.attachment;
      const previous = attachments.get(attachment.hash);
      if (previous !== undefined && previous !== attachment.byteSize)
        invalid("conflicting attachment size");
      attachments.set(attachment.hash, attachment.byteSize);
    }
  }
  if (
    through !== manifest.recording.throughServerSeq ||
    timeline !== manifest.recording.timelineMs ||
    gaps !== manifest.provenance.gapCount ||
    // Older archives omit the field and cannot contain the event.
    canonicalJson(notice ?? null) !==
      canonicalJson(manifest.provenance.completenessNotice ?? null) ||
    lifecycle !== manifest.recording.lifecycle ||
    manifest.provenance.completeness !==
      (lifecycle === "ended" ? "ended-recording" : "captured-prefix")
  )
    invalid("manifest boundary/count mismatch");
  for (const [hash, byteSize] of attachments) {
    const file = manifest.files.find(
      (entry) => entry.path === `attachments/${hash}`,
    );
    if (!file || file.byteSize !== byteSize)
      invalid("missing referenced attachment");
  }
  for (const file of manifest.files)
    if (file.path !== "events.jsonl" && !attachments.has(file.hash))
      invalid("unreferenced attachment");
}

/** Export to a new file only. Sources are staged privately before ZIP publication. */
export async function writeArchive(
  destination: string,
  metadata: ArchiveMetadata,
  events: AsyncIterable<StoredEvent>,
  attachment: (hash: string, signal?: AbortSignal) => Promise<Readable>,
  signal?: AbortSignal,
): Promise<ArchiveManifest> {
  const directory = await mkdtemp(
    join(dirname(destination), ".agentlive-export-"),
  );
  try {
    await mkdir(join(directory, "attachments"), { mode: 0o700 });
    const handle = await open(join(directory, "events.jsonl"), "wx", 0o600);
    const attachments = new Map<string, number>();
    let bytes = 0;
    try {
      for await (const value of events) {
        signal?.throwIfAborted();
        const event = storedEventSchema.parse(value);
        const line = canonicalJson(event) + "\n";
        const size = Buffer.byteLength(line);
        bytes += size;
        if (size - 1 > MAX_EVENT || bytes > MAX_TOTAL)
          invalid("event size limit");
        await handle.writeFile(line);
        if (event.content.kind === "attachment.available") {
          const ref = event.content.payload.attachment;
          if (
            attachments.has(ref.hash) &&
            attachments.get(ref.hash) !== ref.byteSize
          )
            invalid("conflicting attachment size");
          attachments.set(ref.hash, ref.byteSize);
          if (attachments.size >= MAX_FILES - 1) invalid("file count limit");
        }
      }
    } finally {
      await handle.close();
    }
    const files: ArchiveManifest["files"] = [
      {
        path: "events.jsonl",
        ...(await hashFile(join(directory, "events.jsonl"), MAX_TOTAL, signal)),
      },
    ];
    for (const [hash, expected] of attachments) {
      if (expected > MAX_ATTACHMENT || bytes + expected > MAX_TOTAL)
        invalid("attachment size limit");
      let size = 0;
      const bounded = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(
            size > expected
              ? new Error("Attachment exceeds declared size")
              : null,
            chunk,
          );
        },
      });
      const path = `attachments/${hash}`;
      await pipeline(
        await attachment(hash, signal),
        bounded,
        createWriteStream(join(directory, path), { flags: "wx", mode: 0o600 }),
        { ...(signal ? { signal } : {}) },
      );
      const actual = await hashFile(
        join(directory, path),
        MAX_ATTACHMENT,
        signal,
      );
      if (actual.byteSize !== expected || actual.hash !== hash)
        invalid("attachment bytes differ");
      bytes += actual.byteSize;
      files.push({ path, ...actual });
    }
    const manifest = archiveManifestSchema.parse({ ...metadata, files });
    await verify(directory, manifest, signal);
    const encoded = canonicalJson(manifest);
    if (Buffer.byteLength(encoded) > MAX_MANIFEST)
      invalid("manifest size limit");
    const zip = new ZipFile();
    const output = join(directory, "recording.zip");
    const completion = pipeline(
      zip.outputStream,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
      { ...(signal ? { signal } : {}) },
    );
    zip.on("error", (error: Error) =>
      (zip.outputStream as Readable).destroy(error),
    );
    zip.addBuffer(Buffer.from(encoded), "manifest.json");
    for (const file of files)
      zip.addFile(join(directory, file.path), file.path, { mode: 0o100600 });
    zip.end();
    await completion;
    signal?.throwIfAborted();
    const finished = await open(output, "r");
    try {
      await finished.sync();
    } finally {
      await finished.close();
    }
    await link(output, destination); // No accidental replacement of an existing export.
    await syncDirectory(dirname(destination));
    return manifest;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Extract only recording data into an owned temporary directory, then validate all bytes. */
export async function openArchive(
  path: string,
  signal?: AbortSignal,
): Promise<OpenArchive> {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-archive-"));
  let zip: yauzl.ZipFile | undefined;
  let extraction: Promise<void> | undefined;
  const extractionStop = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, extractionStop.signal])
    : extractionStop.signal;
  try {
    await mkdir(join(directory, "attachments"), { mode: 0o700 });
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(
        path,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, file) => (error ? reject(error) : resolve(file!)),
      ),
    );
    if (zip.entryCount > MAX_FILES) invalid("file count limit");
    const seen = new Set<string>();
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const archive = zip!;
      const abort = () => {
        archive.close();
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      archive.once("error", (error) => {
        extractionStop.abort(error);
        cleanup();
        reject(error);
      });
      archive.once("end", () => {
        cleanup();
        resolve();
      });
      archive.on("entry", (entry: yauzl.Entry) => {
        extraction = (async () => {
          signal?.throwIfAborted();
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if (
            !allowed.test(entry.fileName) ||
            seen.has(entry.fileName) ||
            ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) ||
            mode & 0o111 ||
            entry.isEncrypted() ||
            ![0, 8].includes(entry.compressionMethod)
          )
            invalid("unsupported or duplicate ZIP entry");
          seen.add(entry.fileName);
          const limit =
            entry.fileName === "manifest.json"
              ? MAX_MANIFEST
              : entry.fileName === "events.jsonl"
                ? MAX_TOTAL
                : MAX_ATTACHMENT;
          total += entry.uncompressedSize;
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > limit ||
            total > MAX_TOTAL + MAX_MANIFEST
          )
            invalid("expanded size limit");
          const input = await new Promise<Readable>((res, rej) =>
            archive.openReadStream(entry, (error, stream) =>
              error ? rej(error) : res(stream!),
            ),
          );
          let expanded = 0;
          const bounded = new Transform({
            transform(chunk, _encoding, done) {
              expanded += chunk.length;
              done(
                expanded > entry.uncompressedSize
                  ? new Error("ZIP entry exceeds declared size")
                  : null,
                chunk,
              );
            },
          });
          await pipeline(
            input,
            bounded,
            createWriteStream(join(directory, entry.fileName), {
              flags: "wx",
              mode: 0o600,
            }),
            { signal: active },
          );
          if (expanded !== entry.uncompressedSize) invalid("ZIP size mismatch");
          archive.readEntry();
        })().catch((error) => {
          cleanup();
          archive.close();
          reject(error);
        });
      });
      if (signal?.aborted) abort();
      else archive.readEntry();
    });
    const manifest = archiveManifestSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readFile(join(directory, "manifest.json")),
        ),
      ),
    );
    if (
      seen.size !== manifest.files.length + 1 ||
      manifest.files.some((file) => !seen.has(file.path))
    )
      invalid("manifest file set differs");
    await verify(directory, manifest, signal);
    let closed = false;
    const attachmentPaths = new Set(manifest.files.map((file) => file.path));
    return {
      manifest: structuredClone(manifest),
      events: (active) => {
        if (closed) throw new Error("Archive is closed");
        return eventsAt(join(directory, "events.jsonl"), active);
      },
      attachment: (hash) => {
        if (closed) throw new Error("Archive is closed");
        if (
          !/^[a-f0-9]{64}$/.test(hash) ||
          !attachmentPaths.has(`attachments/${hash}`)
        )
          invalid("unknown attachment");
        return createReadStream(join(directory, "attachments", hash));
      },
      close: async () => {
        closed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    extractionStop.abort(error);
    await extraction?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    zip?.close();
  }
}
