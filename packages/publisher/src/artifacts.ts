import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  attachmentSchema,
  canonicalJson,
  hashSchema,
  idSchema,
  ProtocolError,
} from "@agentlive/protocol";
import {
  atomicJson,
  BlobStore,
  FileLock,
  syncDirectory,
} from "@agentlive/storage";
import { StreamingByteRedactor, StreamingRedactor } from "./filter.js";

export type CapturedAttachment = z.infer<typeof attachmentSchema>;
/**
 * Which rule decides whether captured bytes are filtered for known secrets.
 *
 * 1. `declared-text` (historical): only captures whose caller declared `text`
 *    were filtered, so an unrecognised file extension or a transcript-supplied
 *    media type could store a secret verbatim.
 * 2. `utf8-sniff` (current): the captured bytes themselves decide. Bytes that
 *    decode as strict UTF-8 are filtered as text; bytes that do not are scanned
 *    for the UTF-8 encoding of each secret at the byte level. The declared
 *    `text` flag is not consulted.
 *
 * The value is pinned in the spool directory on first open. A spool that
 * already holds captures keeps rule 1, so retries of an existing binding stay
 * byte-identical; every new spool pins rule 2.
 */
export type ArtifactRedactionPolicy = 1 | 2;
export const CURRENT_ARTIFACT_REDACTION: ArtifactRedactionPolicy = 2;
const policySchema = z.strictObject({
  version: z.literal(1),
  artifactRedaction: z.union([z.literal(1), z.literal(2)]),
});
const EMPTY = Buffer.alloc(0);
interface ChunkFilter {
  push(chunk: Uint8Array): Uint8Array;
  finish(): Uint8Array;
}
const passthroughFilter = (): ChunkFilter => ({
  push: (chunk) => chunk,
  finish: () => EMPTY,
});
/** `ignoreBOM` stays false for rule 1, which dropped a leading byte-order mark. */
const textFilter = (
  secrets: readonly string[],
  ignoreBOM: boolean,
): ChunkFilter => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM });
  const redactor = new StreamingRedactor(secrets);
  return {
    push: (chunk) =>
      Buffer.from(redactor.push(decoder.decode(chunk, { stream: true }))),
    finish: () =>
      Buffer.from(redactor.push(decoder.decode()) + redactor.finish()),
  };
};
const byteFilter = (secrets: readonly string[]): ChunkFilter => {
  const redactor = new StreamingByteRedactor(secrets);
  return {
    push: (chunk) => redactor.push(chunk),
    finish: () => redactor.finish(),
  };
};
/** True when the whole byte sequence is strict UTF-8; consumed chunk by chunk. */
class Utf8Probe {
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  private valid = true;
  push(chunk: Uint8Array): void {
    if (!this.valid) return;
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.valid = false;
    }
  }
  finish(): boolean {
    if (!this.valid) return false;
    try {
      this.decoder.decode();
    } catch {
      this.valid = false;
    }
    return this.valid;
  }
}
export interface ArtifactCapture {
  artifactId: string;
  sourceKey: string;
  path: string;
  mediaType: string;
  text: boolean;
  historical: boolean;
  expectedSourceHash?: string;
}
export interface InlineArtifactCapture {
  artifactId: string;
  sourceKey: string;
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
  text: boolean;
  historical: boolean;
}
const bindingSchema = z.strictObject({
  requestHash: hashSchema,
  attachment: attachmentSchema,
});
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Immutable local bytes and reference bindings; call before announcing availability. */
export class ArtifactSpool {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(
    private readonly directory: string,
    private readonly roots: string[],
    private readonly secrets: string[],
    private readonly lock: FileLock,
    private readonly blobs: BlobStore,
    /** Pinned for the life of the spool directory; see ArtifactRedactionPolicy. */
    readonly redaction: ArtifactRedactionPolicy,
  ) {}
  static async open(
    directory: string,
    options: {
      allowedRoots: readonly string[];
      secrets?: readonly string[];
      maxBlobBytes?: number;
      /** Rejected when it contradicts an already pinned policy. */
      redaction?: ArtifactRedactionPolicy;
    },
  ): Promise<ArtifactSpool> {
    const roots = await Promise.all(
      options.allowedRoots.map((root) => realpath(root)),
    );
    const secrets = [...new Set(options.secrets ?? [])].sort();
    new StreamingRedactor(secrets);
    new StreamingByteRedactor(secrets);
    const lock = await FileLock.acquire(join(directory, ".lock"));
    try {
      const policyPath = join(directory, "policy.json");
      let redaction: ArtifactRedactionPolicy | undefined;
      try {
        redaction = policySchema.parse(
          JSON.parse(await readFile(policyPath, "utf8")),
        ).artifactRedaction;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        redaction !== undefined &&
        options.redaction !== undefined &&
        options.redaction !== redaction
      )
        throw new ProtocolError(
          "precondition_failed",
          "Artifact capture redaction policy changed; explicit migration is required",
        );
      if (redaction === undefined) {
        // Bytes already captured here were produced under the historical rule;
        // changing it would change their hashes under a pinned request identity.
        let captured: string[] = [];
        try {
          captured = await readdir(join(directory, "references"));
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== "ENOENT")
            throw missing;
        }
        redaction =
          options.redaction ??
          (captured.length ? 1 : CURRENT_ARTIFACT_REDACTION);
      }
      await mkdir(join(directory, "references"), {
        recursive: true,
        mode: 0o700,
      });
      await atomicJson(policyPath, {
        version: 1,
        artifactRedaction: redaction,
      });
      await syncDirectory(directory);
      const blobs = await BlobStore.open(
        join(directory, "blobs"),
        options.maxBlobBytes === undefined
          ? {}
          : { maxBlobBytes: options.maxBlobBytes },
      );
      return new ArtifactSpool(
        directory,
        roots,
        secrets,
        lock,
        blobs,
        redaction,
      );
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  capture(
    input: ArtifactCapture,
    signal?: AbortSignal,
  ): Promise<CapturedAttachment> {
    if (this.closed)
      return Promise.reject(new Error("Artifact spool is closed"));
    const copy = { ...input };
    const operation = this.queue.then(() => this.captureLocked(copy, signal));
    this.queue = operation.catch(() => {});
    return operation;
  }
  /**
   * Rule 2 decides from the bytes: anything that decodes as strict UTF-8 is
   * filtered as text, and anything else is scanned for the UTF-8 encoding of
   * each secret. Rule 1 consults only the caller's declaration, and still fails
   * the capture when bytes declared as text are not decodable.
   */
  private filterBytes(declaredText: boolean, bytes: Buffer): Buffer {
    if (this.redaction === 1) {
      if (!declaredText) return bytes;
      const redactor = new StreamingRedactor(this.secrets);
      return Buffer.from(
        redactor.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) +
          redactor.finish(),
      );
    }
    if (!this.secrets.length) return bytes;
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      const redactor = new StreamingRedactor(this.secrets);
      return Buffer.from(redactor.push(text) + redactor.finish());
    }
    const redactor = new StreamingByteRedactor(this.secrets);
    return Buffer.concat([redactor.push(bytes), redactor.finish()]);
  }
  /** Chunked form of the same rule; `utf8` comes from a probe of every byte. */
  private streamFilter(declaredText: boolean, utf8: boolean): ChunkFilter {
    if (this.redaction === 1)
      return declaredText
        ? textFilter(this.secrets, false)
        : passthroughFilter();
    if (!this.secrets.length) return passthroughFilter();
    return utf8 ? textFilter(this.secrets, true) : byteFilter(this.secrets);
  }
  private queuedInlineBytes = 0;
  async captureInline(
    input: InlineArtifactCapture,
    signal?: AbortSignal,
  ): Promise<CapturedAttachment> {
    if (this.closed) throw new Error("Artifact spool is closed");
    signal?.throwIfAborted();
    if (
      input.bytes.byteLength + this.queuedInlineBytes >
      this.blobs.limits.maxBlobBytes
    )
      throw new ProtocolError(
        "invalid_request",
        "Inline attachment queue exceeds byte limit",
      );
    const copy = { ...input, bytes: Buffer.from(input.bytes) };
    this.queuedInlineBytes += copy.bytes.byteLength;
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted();
      idSchema.parse(copy.artifactId);
      z.string().min(1).max(1024).parse(copy.sourceKey);
      z.string().min(1).max(255).parse(copy.filename);
      z.string().min(1).max(128).parse(copy.mediaType);
      const { bytes, ...metadata } = copy;
      const sourceHash = hash(bytes);
      const requestHash = hash(
        canonicalJson({
          ...metadata,
          sourceHash,
          filter: hash(canonicalJson(this.secrets)),
          encoding: "inline-v1",
          // Absent for rule 1, so bindings pinned before the sniffing rule keep
          // their request identity and resolve to their original bytes.
          ...(this.redaction === 1 ? {} : { redaction: "utf8-sniff-v2" }),
        }),
      );
      const referenceDirectory = join(
        this.directory,
        "references",
        copy.artifactId,
      );
      const bindingPath = join(
        referenceDirectory,
        `${hash(copy.sourceKey)}.json`,
      );
      let existing: z.infer<typeof bindingSchema> | undefined;
      try {
        existing = bindingSchema.parse(
          JSON.parse(await readFile(bindingPath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ProtocolError(
            "precondition_failed",
            "Inline source identity or capture policy changed",
          );
        await this.blobs.verify(existing.attachment);
        return existing.attachment;
      }
      const filtered = this.filterBytes(copy.text, bytes);
      const descriptor = {
        hash: hash(filtered),
        byteSize: filtered.byteLength,
      };
      async function* chunks() {
        for (let offset = 0; offset < filtered.length; offset += 65536)
          yield filtered.subarray(offset, offset + 65536);
      }
      const staged = await this.blobs.stage(descriptor, chunks(), signal);
      try {
        signal?.throwIfAborted();
        await this.blobs.install(staged);
      } catch (error) {
        await this.blobs.discard(staged);
        throw error;
      }
      await mkdir(referenceDirectory, { recursive: true, mode: 0o700 });
      await syncDirectory(join(this.directory, "references"));
      let version = 1;
      for (const entry of await readdir(referenceDirectory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const previous = bindingSchema.parse(
          JSON.parse(await readFile(join(referenceDirectory, entry), "utf8")),
        );
        version = Math.max(version, previous.attachment.version + 1);
      }
      const nameFilter = new StreamingRedactor(this.secrets);
      const attachment = attachmentSchema.parse({
        ...descriptor,
        artifactId: copy.artifactId,
        version,
        filename: nameFilter.push(copy.filename) + nameFilter.finish(),
        mediaType: copy.mediaType,
        sourceHash,
        capturedAt: new Date().toISOString(),
        provenance: copy.historical ? "historical-version" : "live-capture",
      });
      await atomicJson(bindingPath, { requestHash, attachment });
      return attachment;
    });
    this.queue = operation.catch(() => {});
    try {
      return await operation;
    } finally {
      this.queuedInlineBytes -= copy.bytes.byteLength;
    }
  }
  private async captureLocked(
    input: ArtifactCapture,
    signal?: AbortSignal,
  ): Promise<CapturedAttachment> {
    signal?.throwIfAborted();
    idSchema.parse(input.artifactId);
    z.string().min(1).max(1024).parse(input.sourceKey);
    z.string().min(1).max(128).parse(input.mediaType);
    if (input.expectedSourceHash !== undefined)
      hashSchema.parse(input.expectedSourceHash);
    const sourcePath = resolve(
      input.path.startsWith("file:") ? fileURLToPath(input.path) : input.path,
    );
    const requestHash = hash(
      canonicalJson({
        ...input,
        path: sourcePath,
        roots: this.roots,
        filter: hash(canonicalJson(this.secrets)),
        // Absent for rule 1, so bindings pinned before the sniffing rule keep
        // their request identity and resolve to their original bytes.
        ...(this.redaction === 1 ? {} : { redaction: "utf8-sniff-v2" }),
      }),
    );
    const referenceDirectory = join(
      this.directory,
      "references",
      input.artifactId,
    );
    const bindingPath = join(
      referenceDirectory,
      `${hash(input.sourceKey)}.json`,
    );
    let existing: z.infer<typeof bindingSchema> | undefined;
    try {
      existing = bindingSchema.parse(
        JSON.parse(await readFile(bindingPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ProtocolError(
          "event_conflict",
          "Artifact source identity or capture policy changed",
        );
      await this.blobs.verify(existing.attachment);
      return existing.attachment;
    }
    const path = await realpath(sourcePath);
    if (
      !this.roots.some((root) => {
        const child = relative(root, path);
        return (
          child === "" ||
          (!isAbsolute(child) &&
            child !== ".." &&
            !child.startsWith(`..${sep}`))
        );
      })
    )
      throw new ProtocolError(
        "invalid_request",
        "Artifact is outside configured source roots",
      );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size > BigInt(this.blobs.limits.maxBlobBytes)
      )
        throw new ProtocolError(
          "invalid_request",
          "Artifact must be a regular file within the capture size limit",
        );
      // The source-hash pass also decides text vs. binary, so sniffing the
      // bytes costs no extra read; a binary file fails the probe at its first
      // invalid byte and the rest of the pass only hashes.
      const raw = createHash("sha256");
      const probe = new Utf8Probe();
      for (let position = 0; position < Number(before.size);) {
        signal?.throwIfAborted();
        const buffer = Buffer.alloc(
          Math.min(65536, Number(before.size) - position),
        );
        const { bytesRead } = await file.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (!bytesRead)
          throw new ProtocolError(
            "precondition_failed",
            "Artifact changed during capture",
          );
        const chunk = buffer.subarray(0, bytesRead);
        raw.update(chunk);
        probe.push(chunk);
        position += bytesRead;
      }
      const utf8 = probe.finish();
      const sourceHash = raw.digest("hex");
      if (
        input.expectedSourceHash !== undefined &&
        sourceHash !== input.expectedSourceHash
      )
        throw new ProtocolError(
          "precondition_failed",
          "Historical artifact hash does not match available bytes",
        );
      const makeFilter = () => this.streamFilter(input.text, utf8);
      async function* bytes(): AsyncGenerator<Uint8Array> {
        const filter = makeFilter();
        let position = 0;
        while (position < Number(before.size)) {
          signal?.throwIfAborted();
          const buffer = Buffer.alloc(
            Math.min(65536, Number(before.size) - position),
          );
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (!bytesRead)
            throw new ProtocolError(
              "precondition_failed",
              "Artifact changed during capture",
            );
          position += bytesRead;
          const filtered = filter.push(buffer.subarray(0, bytesRead));
          if (filtered.byteLength) yield filtered;
        }
        const tail = filter.finish();
        if (tail.byteLength) yield tail;
      }
      const digest = createHash("sha256");
      let byteSize = 0;
      for await (const chunk of bytes()) {
        digest.update(chunk);
        byteSize += chunk.byteLength;
      }
      const descriptor = { hash: digest.digest("hex"), byteSize };
      const staged = await this.blobs.stage(descriptor, bytes(), signal);
      try {
        const after = await file.stat({ bigint: true });
        const current = await realpath(sourcePath);
        const pathFile = await open(
          current,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let pathStat;
        try {
          pathStat = await pathFile.stat({ bigint: true });
        } finally {
          await pathFile.close();
        }
        if (
          current !== path ||
          before.dev !== pathStat.dev ||
          before.ino !== pathStat.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new ProtocolError(
            "precondition_failed",
            "Artifact changed during capture",
          );
        signal?.throwIfAborted();
        await this.blobs.install(staged);
      } catch (error) {
        await this.blobs.discard(staged);
        throw error;
      }
      await mkdir(referenceDirectory, { recursive: true, mode: 0o700 });
      await syncDirectory(join(this.directory, "references"));
      let version = 1;
      for (const entry of await readdir(referenceDirectory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const previous = bindingSchema.parse(
          JSON.parse(await readFile(join(referenceDirectory, entry), "utf8")),
        );
        version = Math.max(version, previous.attachment.version + 1);
      }
      const filenameFilter = new StreamingRedactor(this.secrets);
      const filename =
        filenameFilter.push(basename(path)) + filenameFilter.finish();
      const attachment = attachmentSchema.parse({
        artifactId: input.artifactId,
        version,
        ...descriptor,
        filename,
        mediaType: input.mediaType,
        capturedAt: new Date().toISOString(),
        sourceHash,
        provenance: input.historical
          ? input.expectedSourceHash
            ? "historical-version"
            : "current-file"
          : "live-capture",
      });
      await atomicJson(bindingPath, { requestHash, attachment });
      return attachment;
    } finally {
      await file.close();
    }
  }
  /** File handle ownership passes to caller. Only locally captured hashes are accepted. */
  async openFile(attachment: CapturedAttachment) {
    if (this.closed) throw new Error("Artifact spool is closed");
    await this.blobs.verify(attachment);
    return this.blobs.openFile(attachment.hash);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try {
      await this.blobs.close();
    } finally {
      await this.lock.release();
    }
  }
}
