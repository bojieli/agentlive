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
import { StreamingRedactor } from "./filter.js";

export type CapturedAttachment = z.infer<typeof attachmentSchema>;
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
  ) {}
  static async open(
    directory: string,
    options: {
      allowedRoots: readonly string[];
      secrets?: readonly string[];
      maxBlobBytes?: number;
    },
  ): Promise<ArtifactSpool> {
    const roots = await Promise.all(
      options.allowedRoots.map((root) => realpath(root)),
    );
    const secrets = [...new Set(options.secrets ?? [])].sort();
    new StreamingRedactor(secrets);
    const lock = await FileLock.acquire(join(directory, ".lock"));
    try {
      await mkdir(join(directory, "references"), {
        recursive: true,
        mode: 0o700,
      });
      await syncDirectory(directory);
      const blobs = await BlobStore.open(
        join(directory, "blobs"),
        options.maxBlobBytes === undefined
          ? {}
          : { maxBlobBytes: options.maxBlobBytes },
      );
      return new ArtifactSpool(directory, roots, secrets, lock, blobs);
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
      const redactor = new StreamingRedactor(this.secrets);
      const text = copy.text
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : "";
      const filtered = copy.text
        ? Buffer.from(redactor.push(text) + redactor.finish())
        : bytes;
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
      const secrets = this.secrets;
      async function* bytes(): AsyncGenerator<Uint8Array> {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const filter = new StreamingRedactor(secrets);
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
          const chunk = buffer.subarray(0, bytesRead);
          yield input.text
            ? Buffer.from(filter.push(decoder.decode(chunk, { stream: true })))
            : chunk;
        }
        if (input.text)
          yield Buffer.from(filter.push(decoder.decode()) + filter.finish());
      }
      const raw = createHash("sha256");
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
        raw.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const sourceHash = raw.digest("hex");
      if (
        input.expectedSourceHash !== undefined &&
        sourceHash !== input.expectedSourceHash
      )
        throw new ProtocolError(
          "precondition_failed",
          "Historical artifact hash does not match available bytes",
        );
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
