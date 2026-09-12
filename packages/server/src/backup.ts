import { sessionMetadataSchema } from "./session.js";
import { readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { FileLock, atomicJson, syncDirectory } from "@agentlive/storage";
import { ProtocolError, canonicalJson } from "@agentlive/protocol";
import { RecordingStore } from "./store.js";
import type { WriteBarrier } from "./write-barrier.js";

const maximumBytes = 100 * 1024 ** 3;
const maximumEntries = 100000;
const maximumDepth = 32;

const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
  );
};

/** Resolve a new output path whose parent exists, outside the server tree. */
async function backupTarget(directory: string, output: string) {
  const source = await realpath(directory);
  const target = join(
    await realpath(dirname(resolve(output))),
    resolve(output).split(sep).at(-1)!,
  );
  if (inside(target, source) || inside(source, target))
    throw new Error("Backup output must be outside the server directory");
  return { source, output: target };
}

/** Streamed, bounded copy of regular files. Each instance owns one budget. */
class BackupCopier {
  total = 0;
  nodes = 0;
  constructor(private readonly signal: AbortSignal) {}
  check() {
    this.signal.throwIfAborted();
  }
  /** Returns the SHA-256 of the copied bytes when requested. */
  async copyFile(sourcePath: string, targetPath: string, digest = false) {
    this.check();
    const input = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let outputFile;
    const hash = digest ? createHash("sha256") : undefined;
    try {
      const before = await input.stat();
      if (!before.isFile())
        throw new Error(
          "Backup source must contain only regular files and directories",
        );
      if ((this.total += before.size) > maximumBytes)
        throw new Error("Backup exceeds the supported 100 GiB limit");
      outputFile = await open(targetPath, "wx", 0o600);
      const bytes = Buffer.alloc(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        this.check();
        const result = await input.read(
          bytes,
          0,
          Math.min(bytes.length, before.size - offset),
          offset,
        );
        if (!result.bytesRead)
          throw new Error("Backup source changed while copying");
        hash?.update(bytes.subarray(0, result.bytesRead));
        let written = 0;
        while (written < result.bytesRead) {
          const resultWrite = await outputFile.write(
            bytes,
            written,
            result.bytesRead - written,
            offset + written,
          );
          if (!resultWrite.bytesWritten)
            throw new Error("Backup write made no progress");
          written += resultWrite.bytesWritten;
        }
        offset += result.bytesRead;
      }
      const after = await input.stat();
      const current = await lstat(sourcePath);
      if (
        current.isSymbolicLink() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("Backup source changed while copying");
      await outputFile.sync();
      return hash?.digest("hex");
    } finally {
      await outputFile?.close();
      await input.close();
    }
  }
  /** `skip` receives server-relative POSIX paths. `reuse` names output files
   * and directories already populated by an earlier verified pass. */
  async copyTree(
    from: string,
    to: string,
    options: {
      skip?: (path: string) => boolean;
      reuse?: Reused;
      path?: string;
      depth?: number;
    } = {},
  ) {
    const depth = options.depth ?? 0;
    this.check();
    if (depth > maximumDepth)
      throw new Error("Backup directory nesting exceeds limit");
    if (options.reuse?.directories.has(to)) options.reuse.visited.add(to);
    else await mkdir(to, { mode: 0o700 });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      this.check();
      if (++this.nodes > maximumEntries)
        throw new Error("Backup contains too many entries");
      if (entry.name.endsWith(".lock")) continue;
      const path = options.path ? `${options.path}/${entry.name}` : entry.name;
      // In-flight transfer staging is transient and belongs to no recording.
      if (path === "staging") continue;
      if (options.skip?.(path)) continue;
      const input = join(from, entry.name),
        target = join(to, entry.name);
      if (entry.isDirectory())
        await this.copyTree(input, target, {
          ...options,
          path,
          depth: depth + 1,
        });
      else if (entry.isFile()) {
        if (options.reuse?.files.has(target)) {
          const size = (await lstat(target)).size;
          if ((this.total += size) > maximumBytes)
            throw new Error("Backup exceeds the supported 100 GiB limit");
          options.reuse.visited.add(target);
        } else await this.copyFile(input, target);
      } else throw new Error("Backup refuses symbolic links and special files");
    }
    await syncDirectory(to);
  }
}
interface Reused {
  files: Set<string>;
  directories: Set<string>;
  visited: Set<string>;
}

/** Recover and validate the copied server state, then write the completion manifest. */
async function completeBackup(output: string, check: () => void) {
  let store: RecordingStore | undefined;
  const entries: { path: string; byteSize: number; hash: string }[] = [];
  async function inventory(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      check();
      if (entry.name.endsWith(".lock")) continue;
      const path = join(directory, entry.name),
        name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await inventory(path, name);
      else {
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const hash = createHash("sha256");
          const bytes = Buffer.alloc(1024 * 1024);
          let byteSize = 0;
          for (;;) {
            check();
            const { bytesRead } = await file.read(
              bytes,
              0,
              bytes.length,
              byteSize,
            );
            if (!bytesRead) break;
            hash.update(bytes.subarray(0, bytesRead));
            byteSize += bytesRead;
          }
          entries.push({ path: name, byteSize, hash: hash.digest("hex") });
        } finally {
          await file.close();
        }
      }
    }
  }
  try {
    // Recover only the copy: the original server files remain untouched.
    store = await RecordingStore.open(join(output, "server"));
    let recordings = 0;
    for (const entry of await readdir(join(output, "server", "sessions"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      check();
      const metadata = sessionMetadataSchema.parse(
        JSON.parse(
          await readFile(
            join(output, "server", "sessions", entry.name, "metadata.json"),
            "utf8",
          ),
        ),
      );
      if (!metadata.removed) {
        const session = await store.get(entry.name);
        store.release(session);
      }
      recordings++;
    }
    await store.close();
    store = undefined;
    await inventory(output, "");
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      format: "agentlive.server-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      recordings,
      files: entries.map((entry) => ({ ...entry, path: entry.path.slice(1) })),
    };
    check();
    await atomicJson(join(output, "backup.json"), manifest);
    await syncDirectory(output);
    await syncDirectory(dirname(output));
    return {
      output,
      recordings,
      files: entries.length,
      byteSize: entries.reduce((size, entry) => size + entry.byteSize, 0),
    };
  } finally {
    await store?.close();
  }
}

/** Offline operational backup: credentials and server state, never publisher state.
 * A manifest is the completion marker. A crash can leave an incomplete directory
 * which must not be treated as a restorable backup. */
export async function backupServer(options: {
  directory: string;
  ownerFile: string;
  output: string;
  signal: AbortSignal;
}) {
  const { source, output } = await backupTarget(
    options.directory,
    options.output,
  );
  const lock = await FileLock.acquire(join(source, ".server.lock"));
  let ownerLock: FileLock | undefined;
  let created = false;
  const copier = new BackupCopier(options.signal);
  const check = () => copier.check();
  try {
    ownerLock = await FileLock.acquire(options.ownerFile + ".lock");
    const ownerStat = await lstat(options.ownerFile);
    if (
      !ownerStat.isFile() ||
      (ownerStat.mode & 0o077) !== 0 ||
      ownerStat.size > 4096
    )
      throw new Error("Backup requires an owner-only regular credential file");
    check();
    await mkdir(output, { mode: 0o700 });
    created = true;
    await copier.copyFile(options.ownerFile, join(output, "owner.json"));
    const owner = await open(join(output, "owner.json"), "r");
    try {
      const stat = await owner.stat();
      if (stat.size > 4096) throw new Error("Invalid backup owner credential");
      const value = JSON.parse(await owner.readFile("utf8"));
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.secret))
        throw new Error("Invalid backup owner credential");
    } finally {
      await owner.close();
    }
    await copier.copyTree(source, join(output, "server"));
    return await completeBackup(output, check);
  } catch (error) {
    if (created) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await ownerLock?.release();
    await lock.release();
  }
}

/** Derivative snapshots/leases (removed by restore) and in-flight upload staging
 * (discarded on open) are not authoritative and keep running during a backup. */
const onlineSkip = (path: string) =>
  /^sessions\/[^/]+\/snapshots$/.test(path) ||
  /^sessions\/[^/]+\/attachments\/\.uploads$/.test(path);
const running = new WeakSet<WriteBarrier>();

export type OnlineBackupPhase = "attachments" | "barrier" | "verifying";

/** Online backup of a running server, in the offline backup format.
 *
 * 1. Content-addressed attachment files are pre-copied and hash-verified
 *    without pausing writers.
 * 2. The server write barrier stops admitting durable mutations, drains admitted
 *    ones, and the remaining authoritative state (metadata, event logs, ledgers,
 *    attachments added meanwhile) is copied; pre-copied attachments that no
 *    longer exist are dropped. The barrier is released on success, failure,
 *    cancellation, or when `barrierTimeoutMs` elapses (the backup then fails).
 * 3. The copy is recovered/validated and hashed into the manifest after the
 *    barrier is released.
 *
 * `prepare` validates the destination and creates it (so callers can report
 * path errors before starting); `run` performs the backup and deletes the
 * partial output on any failure. */
export async function prepareOnlineBackup(options: {
  server: { directory: string; barrier: WriteBarrier };
  ownerSecret: string;
  output: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.ownerSecret))
    throw new Error("Invalid server owner credential");
  const barrier = options.server.barrier;
  if (running.has(barrier) || barrier.paused)
    throw new ProtocolError(
      "retry_later",
      "A server backup is already running",
    );
  if (!isAbsolute(options.output))
    throw new ProtocolError(
      "invalid_request",
      "Backup output must be an absolute server-host path",
    );
  let target: { source: string; output: string };
  try {
    target = await backupTarget(options.server.directory, options.output);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new ProtocolError(
        "invalid_request",
        "Backup output parent directory must exist on the server host",
      );
    if (
      (error as Error).message ===
      "Backup output must be outside the server directory"
    )
      throw new ProtocolError("invalid_request", (error as Error).message);
    throw error;
  }
  if (running.has(barrier))
    throw new ProtocolError(
      "retry_later",
      "A server backup is already running",
    );
  running.add(barrier);
  const { source, output } = target;
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    running.delete(barrier);
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ProtocolError(
        "invalid_request",
        "Backup output must be a new directory",
      );
    throw error;
  }
  let started = false;
  const release = async () => {
    try {
      // The plaintext owner credential goes first, so a directory that cannot
      // be removed never keeps the secret. Admission is always reopened: a
      // failed cleanup must not wedge every later backup.
      await rm(join(output, "owner.json"), { force: true });
      await rm(output, { recursive: true, force: true });
    } finally {
      running.delete(barrier);
    }
  };
  return {
    output,
    /** Remove the created destination when `run` will not be called. */
    abandon: async () => {
      if (!started) await release();
    },
    async run(runOptions: {
      signal: AbortSignal;
      barrierTimeoutMs?: number;
      onPhase?: (phase: OnlineBackupPhase) => void;
    }) {
      if (started) throw new Error("Online backup already started");
      started = true;
      const barrierTimeoutMs = runOptions.barrierTimeoutMs ?? 30_000;
      try {
        if (
          !Number.isSafeInteger(barrierTimeoutMs) ||
          barrierTimeoutMs < 1 ||
          barrierTimeoutMs > 600_000
        )
          throw new RangeError("Invalid backup barrier timeout");
        const copier = new BackupCopier(runOptions.signal);
        const check = () => copier.check();
        const owner = await open(join(output, "owner.json"), "wx", 0o600);
        try {
          await owner.writeFile(
            canonicalJson({ version: 1, secret: options.ownerSecret }) + "\n",
          );
          await owner.sync();
        } finally {
          await owner.close();
        }
        const server = join(output, "server");
        runOptions.onPhase?.("attachments");
        const reuse = await precopyAttachments(
          source,
          server,
          runOptions.signal,
        );
        runOptions.onPhase?.("barrier");
        const deadline = AbortSignal.timeout(barrierTimeoutMs);
        const barrierSignal = AbortSignal.any([runOptions.signal, deadline]);
        const paused = Date.now();
        let barrierMs = 0;
        try {
          await barrier.exclusive(async () => {
            await new BackupCopier(barrierSignal).copyTree(source, server, {
              skip: onlineSkip,
              reuse,
            });
          }, barrierSignal);
        } catch (error) {
          if (deadline.aborted && !runOptions.signal.aborted)
            throw new ProtocolError(
              "retry_later",
              `Backup write barrier exceeded ${barrierTimeoutMs}ms; writes resumed and the partial backup was deleted`,
            );
          throw error;
        } finally {
          barrierMs = Date.now() - paused;
        }
        // Attachments removed after they were pre-copied are not part of the point in time.
        for (const file of reuse.files)
          if (!reuse.visited.has(file)) await rm(file, { force: true });
        for (const directory of [...reuse.directories].reverse())
          if (!reuse.visited.has(directory))
            await rm(directory, { recursive: true, force: true });
        check();
        runOptions.onPhase?.("verifying");
        const result = await completeBackup(output, check);
        running.delete(barrier);
        return { ...result, barrierMs };
      } catch (error) {
        // Report why the backup failed, not why its cleanup did.
        await release().catch(() => {});
        throw error;
      }
    },
  };
}

/** Pre-copy immutable content-addressed attachments without pausing writers.
 * Copies whose bytes do not hash to their name are discarded and left to the
 * barrier pass, which preserves offline-backup behaviour for corrupt files. */
async function precopyAttachments(
  source: string,
  server: string,
  signal: AbortSignal,
): Promise<Reused> {
  const copier = new BackupCopier(signal);
  const reuse: Reused = {
    files: new Set(),
    directories: new Set(),
    visited: new Set(),
  };
  const ensure = async (directory: string) => {
    if (reuse.directories.has(directory)) return;
    await mkdir(directory, { mode: 0o700 });
    reuse.directories.add(directory);
  };
  const missing = (error: unknown) =>
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!);
  let sessions;
  try {
    sessions = await readdir(join(source, "sessions"), { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return reuse;
    throw error;
  }
  for (const session of sessions) {
    copier.check();
    if (!session.isDirectory() || session.name.startsWith(".")) continue;
    const from = join(source, "sessions", session.name, "attachments");
    let files;
    try {
      files = await readdir(from, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const file of files) {
      copier.check();
      if (!file.isFile() || !/^[a-f0-9]{64}$/.test(file.name)) continue;
      if (++copier.nodes > maximumEntries)
        throw new Error("Backup contains too many entries");
      await ensure(server);
      await ensure(join(server, "sessions"));
      await ensure(join(server, "sessions", session.name));
      const to = join(server, "sessions", session.name, "attachments");
      await ensure(to);
      const target = join(to, file.name);
      let hash: string | undefined;
      try {
        hash = await copier.copyFile(join(from, file.name), target, true);
      } catch (error) {
        await rm(target, { force: true });
        signal.throwIfAborted();
        // Removed or replaced concurrently: the barrier pass decides.
        if (
          missing(error) ||
          (error as Error).message === "Backup source changed while copying"
        )
          continue;
        throw error;
      }
      if (hash === file.name) reuse.files.add(target);
      else await rm(target, { force: true });
    }
  }
  return reuse;
}
