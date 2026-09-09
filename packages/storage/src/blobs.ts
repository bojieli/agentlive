import { mkdir, open, readdir, lstat, unlink, link } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hashSchema, ProtocolError } from "@agentlive/protocol";
import { syncDirectory } from "./atomic.js";

export interface BlobDescriptor {
  hash: string;
  byteSize: number;
}
export interface BlobLimits {
  maxBlobBytes: number;
  maxTotalBytes: number;
  maxConcurrentUploads: number;
}
export interface StagedBlob extends BlobDescriptor {
  readonly token: string;
}
interface Upload extends StagedBlob {
  path: string;
}
const defaults: BlobLimits = {
  maxBlobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxConcurrentUploads: 4,
};

/** Caller owns the parent directory lock. Install, references and GC share its session queue. */
export class BlobStore {
  private usedBytes = 0;
  private reservedBytes = 0;
  private activeUploads = 0;
  private readonly active = new Map<AbortController, Promise<void>>();
  private readonly staged = new Map<string, Upload>();
  private closed = false;
  private constructor(
    readonly directory: string,
    private readonly temporaryDirectory: string,
    readonly limits: BlobLimits,
  ) {}
  static async open(
    directory: string,
    limits: Partial<BlobLimits> = {},
  ): Promise<BlobStore> {
    const resolved = { ...defaults, ...limits };
    for (const value of Object.values(resolved))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("Invalid attachment limit");
    const temporaryDirectory = join(directory, ".uploads");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const store = new BlobStore(directory, temporaryDirectory, resolved);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".uploads") continue;
      hashSchema.parse(entry.name);
      if (!entry.isFile())
        throw new ProtocolError(
          "corrupt_storage",
          "Attachment is not a regular file",
        );
      store.usedBytes += (await lstat(join(directory, entry.name))).size;
    }
    // On reopen the enclosing kernel lock proves that none of these uploads is live.
    for (const entry of await readdir(temporaryDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile())
        throw new ProtocolError(
          "corrupt_storage",
          "Unexpected attachment staging entry",
        );
      await unlink(join(temporaryDirectory, entry.name));
    }
    await syncDirectory(temporaryDirectory);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
    return store;
  }
  get usage(): Readonly<{
    storedBytes: number;
    reservedBytes: number;
    activeUploads: number;
  }> {
    return {
      storedBytes: this.usedBytes,
      reservedBytes: this.reservedBytes,
      activeUploads: this.activeUploads,
    };
  }
  private validate(descriptor: BlobDescriptor): void {
    hashSchema.parse(descriptor.hash);
    if (
      !Number.isSafeInteger(descriptor.byteSize) ||
      descriptor.byteSize < 0 ||
      descriptor.byteSize > this.limits.maxBlobBytes
    )
      throw new ProtocolError(
        "invalid_request",
        "Invalid attachment byte size",
      );
  }
  async stage(
    descriptor: BlobDescriptor,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<StagedBlob> {
    descriptor = { ...descriptor };
    this.validate(descriptor);
    if (this.closed)
      throw new ProtocolError("storage_failed", "Attachment store is closed");
    signal?.throwIfAborted();
    if (
      this.activeUploads >= this.limits.maxConcurrentUploads ||
      this.usedBytes + this.reservedBytes + descriptor.byteSize >
        this.limits.maxTotalBytes
    )
      throw new ProtocolError("retry_later", "Attachment capacity exceeded");
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const deadline = setTimeout(
      () => controller.abort(new Error("Attachment upload deadline exceeded")),
      300_000,
    );
    deadline.unref();
    let finished!: () => void;
    const completion = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.active.set(controller, completion);
    this.activeUploads++;
    this.reservedBytes += descriptor.byteSize;
    const upload: Upload = { ...descriptor, token: randomUUID(), path: "" };
    upload.path = join(this.temporaryDirectory, upload.token);
    let file: FileHandle | undefined;
    let completed = false;
    try {
      file = await open(upload.path, "wx", 0o600);
      const digest = createHash("sha256");
      let received = 0;
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          combined.throwIfAborted();
          const result = await new Promise<IteratorResult<Uint8Array>>(
            (resolve, reject) => {
              const cleanup = () =>
                combined.removeEventListener("abort", aborted);
              const aborted = () => {
                cleanup();
                reject(combined.reason);
              };
              combined.addEventListener("abort", aborted, { once: true });
              if (combined.aborted) {
                aborted();
                return;
              }
              Promise.resolve()
                .then(() => iterator.next())
                .then(
                  (result) => {
                    cleanup();
                    resolve(result);
                  },
                  (error) => {
                    cleanup();
                    reject(error);
                  },
                );
            },
          );
          if (result.done) break;
          const chunk = result.value;
          combined.throwIfAborted();
          if (this.closed)
            throw new ProtocolError(
              "storage_failed",
              "Attachment store closed during upload",
            );
          if (!(chunk instanceof Uint8Array))
            throw new ProtocolError(
              "invalid_request",
              "Expected binary attachment chunks",
            );
          received += chunk.byteLength;
          if (received > descriptor.byteSize)
            throw new ProtocolError(
              "invalid_request",
              "Attachment exceeds declared size",
            );
          // Copy once so a producer cannot mutate bytes between hashing and asynchronous writing.
          const bytes = Buffer.from(chunk);
          digest.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await file.write(
              bytes,
              offset,
              bytes.length - offset,
            );
            if (!bytesWritten) throw new Error("Zero-byte attachment write");
            offset += bytesWritten;
          }
        }
      } finally {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
      combined.throwIfAborted();
      if (
        received !== descriptor.byteSize ||
        digest.digest("hex") !== descriptor.hash
      )
        throw new ProtocolError(
          "event_conflict",
          "Attachment hash or size mismatch",
        );
      await file.sync();
      await file.close();
      file = undefined;
      if (this.closed)
        throw new ProtocolError("storage_failed", "Attachment store is closed");
      this.staged.set(upload.token, upload);
      completed = true;
      return {
        hash: upload.hash,
        byteSize: upload.byteSize,
        token: upload.token,
      };
    } finally {
      try {
        await file?.close();
      } finally {
        try {
          this.activeUploads--;
          if (!completed) {
            this.reservedBytes -= descriptor.byteSize;
            await unlink(upload.path).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        } finally {
          clearTimeout(deadline);
          this.active.delete(controller);
          finished();
        }
      }
    }
  }
  /** Must run in the same serialized queue as event reference commits and garbage collection. */
  async install(staged: StagedBlob): Promise<BlobDescriptor> {
    const upload = this.staged.get(staged.token);
    if (
      !upload ||
      upload.hash !== staged.hash ||
      upload.byteSize !== staged.byteSize
    )
      throw new ProtocolError("invalid_request", "Unknown staged attachment");
    if (this.closed)
      throw new ProtocolError("storage_failed", "Attachment store is closed");
    const destination = join(this.directory, upload.hash);
    try {
      let installed = false;
      try {
        await link(upload.path, destination);
        installed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verify(upload);
      }
      if (installed) this.usedBytes += upload.byteSize;
      await syncDirectory(this.directory);
      return { hash: upload.hash, byteSize: upload.byteSize };
    } finally {
      await this.discard(staged);
    }
  }
  async discard(staged: StagedBlob): Promise<void> {
    const upload = this.staged.get(staged.token);
    if (!upload) return;
    this.staged.delete(staged.token);
    this.reservedBytes -= upload.byteSize;
    await unlink(upload.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async openFile(hash: string): Promise<FileHandle> {
    hashSchema.parse(hash);
    if (this.closed)
      throw new ProtocolError("storage_failed", "Attachment store is closed");
    let file: FileHandle;
    try {
      file = await open(
        join(this.directory, hash),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ProtocolError(
          "precondition_failed",
          "Attachment bytes are unavailable",
        );
      throw error;
    }
    try {
      if (!(await file.stat()).isFile())
        throw new ProtocolError(
          "corrupt_storage",
          "Attachment is not a regular file",
        );
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async verify(descriptor: BlobDescriptor): Promise<void> {
    descriptor = { ...descriptor };
    this.validate(descriptor);
    const file = await this.openFile(descriptor.hash);
    try {
      if ((await file.stat()).size !== descriptor.byteSize)
        throw new ProtocolError("corrupt_storage", "Attachment size changed");
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (digest.digest("hex") !== descriptor.hash)
        throw new ProtocolError(
          "corrupt_storage",
          "Attachment checksum changed",
        );
    } finally {
      await file.close();
    }
  }
  /** A frozen set must include all retained event versions and active export/read pins. */
  async collect(
    referenced: ReadonlySet<string>,
    olderThan: number,
  ): Promise<number> {
    if (this.closed)
      throw new ProtocolError("storage_failed", "Attachment store is closed");
    let removed = 0;
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (entry.name === ".uploads" || referenced.has(entry.name)) continue;
      hashSchema.parse(entry.name);
      if (!entry.isFile())
        throw new ProtocolError(
          "corrupt_storage",
          "Unexpected attachment file",
        );
      const path = join(this.directory, entry.name);
      const info = await lstat(path);
      if (info.mtimeMs >= olderThan) continue;
      await unlink(path);
      this.usedBytes -= info.size;
      removed++;
    }
    if (removed) await syncDirectory(this.directory);
    return removed;
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.active.entries()];
    for (const [controller] of active)
      controller.abort(new Error("Attachment store closed"));
    await Promise.all(active.map(([, done]) => done));
    for (const upload of [...this.staged.values()]) await this.discard(upload);
  }
}
