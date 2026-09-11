import { Reports } from "./reports.js";
import { assertSupportedDataFormat } from "./data-format.js";
import { cleanRemovedStorage } from "./removed-storage.js";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  lstat,
  realpath,
  rm,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { FileLock, atomicJson, syncDirectory } from "@agentlive/storage";
import { RecordingSession, sessionMetadataSchema } from "./session.js";
const manifestSchema = z.strictObject({
  format: z.literal("agentlive.server-backup"),
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  recordings: z.number().int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(2048),
        byteSize: z
          .number()
          .int()
          .nonnegative()
          .max(100 * 1024 ** 3),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100000),
});
/** Restore into a new state directory. Startup is fenced until all verification,
 * revision renewal, and directory syncs finish. The backup is never modified. */
export async function restoreServer(options: {
  source: string;
  output: string;
  signal: AbortSignal;
}) {
  const source = await realpath(options.source);
  const output = join(
    await realpath(dirname(resolve(options.output))),
    resolve(options.output).split(sep).at(-1)!,
  );
  const rel = relative(source, output);
  const reverse = relative(output, source);
  const nested = (path: string) =>
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
  if (nested(rel) || nested(reverse))
    throw new Error("Restore destination must be outside the backup");
  const manifestFile = await open(
    join(source, "backup.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let manifest;
  try {
    const stat = await manifestFile.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new Error("Invalid backup manifest size");
    manifest = manifestSchema.parse(
      JSON.parse(await manifestFile.readFile("utf8")),
    );
  } finally {
    await manifestFile.close();
  }
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length || !expected.has("owner.json"))
    throw new Error("Backup has duplicate paths or lacks credentials");
  let total = 0;
  for (const file of manifest.files) {
    if ((total += file.byteSize) > 100 * 1024 ** 3)
      throw new Error("Backup exceeds restore byte limit");
    if (
      (file.path === "owner.json" && file.byteSize > 4096) ||
      (file.path.endsWith("/metadata.json") && file.byteSize > 32768)
    )
      throw new Error("Backup metadata exceeds restore limit");
    const parts = file.path.split("/");
    if (
      (file.path !== "owner.json" && parts[0] !== "server") ||
      parts.length > 34 ||
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..",
      ) ||
      parts.some(
        (part) => part.endsWith(".lock") || part === ".restore-in-progress",
      )
    )
      throw new Error("Unsafe backup path");
  }
  let nodes = 0;
  const found = new Set<string>();
  async function inspect(directory: string, prefix = "", depth = 0) {
    options.signal.throwIfAborted();
    if (depth > 33) throw new Error("Backup nesting exceeds restore limit");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++nodes > 100010)
        throw new Error("Backup exceeds restore entry limit");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await inspect(join(directory, entry.name), path, depth + 1);
      else if (!entry.isFile())
        throw new Error("Restore refuses links and special files");
      else if (path !== "backup.json" && !entry.name.endsWith(".lock")) {
        if (!expected.has(path))
          throw new Error("Backup contains an unlisted file");
        found.add(path);
      }
    }
  }
  await inspect(source);
  if (found.size !== expected.size) throw new Error("Backup files are missing");
  options.signal.throwIfAborted();
  await mkdir(output, { mode: 0o700 });
  let lock: FileLock | undefined;
  try {
    const server = join(output, "server");
    await mkdir(server, { mode: 0o700 });
    lock = await FileLock.acquire(join(server, ".server.lock"));
    await atomicJson(join(server, ".restore-in-progress"), { version: 1 });
    await syncDirectory(output);
    for (const file of manifest.files) {
      options.signal.throwIfAborted();
      // Check every ancestor before opening; source is treated as untrusted data.
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++)
        if (
          !(await lstat(join(source, ...parts.slice(0, index)))).isDirectory()
        )
          throw new Error("Backup path traverses a non-directory");
      const input = await open(
        join(source, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let destination;
      try {
        const stat = await input.stat();
        if (!stat.isFile() || stat.size !== file.byteSize)
          throw new Error("Backup file size differs");
        const target = join(output, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        destination = await open(target, "wx", 0o600);
        const hash = createHash("sha256"),
          buffer = Buffer.alloc(1024 * 1024);
        let offset = 0;
        while (offset < file.byteSize) {
          options.signal.throwIfAborted();
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, file.byteSize - offset),
            offset,
          );
          if (!bytesRead) throw new Error("Backup file truncated");
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const result = await destination.write(
              buffer,
              written,
              bytesRead - written,
              offset + written,
            );
            if (!result.bytesWritten)
              throw new Error("Restore write made no progress");
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        if (hash.digest("hex") !== file.hash)
          throw new Error("Backup checksum differs");
        await destination.sync();
      } finally {
        await destination?.close();
        await input.close();
      }
    }
    // Refuse a backup written by a newer data format before rewriting anything.
    await assertSupportedDataFormat(server);
    const owner = JSON.parse(
      await readFile(join(output, "owner.json"), "utf8"),
    );
    if (
      owner.version !== 1 ||
      typeof owner.secret !== "string" ||
      !/^[a-f0-9]{64}$/.test(owner.secret)
    )
      throw new Error("Invalid restored owner credential");
    const revisions = [];
    const sessions = join(server, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      options.signal.throwIfAborted();
      const directory = join(sessions, entry.name);
      const metadata = sessionMetadataSchema.parse(
        JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")),
      );
      if (metadata.id !== entry.name)
        throw new Error("Restored recording identity differs");
      if (metadata.removed) {
        await cleanRemovedStorage(directory);
        revisions.push({
          streamId: metadata.id,
          previousRevision: metadata.revision,
          revision: metadata.revision,
        });
        continue;
      }
      const revision = randomUUID();
      await atomicJson(join(directory, "metadata.json"), {
        ...metadata,
        revision,
      });
      // Derivatives and snapshot leases belong to the old revision.
      await rm(join(directory, "snapshots"), { recursive: true, force: true });
      const eventSize = (await lstat(join(directory, "events.jsonl"))).size;
      const session = await RecordingSession.open(directory);
      await session.close();
      if ((await lstat(join(directory, "events.jsonl"))).size !== eventSize)
        throw new Error("Backup contains an incomplete event suffix");
      revisions.push({
        streamId: metadata.id,
        previousRevision: metadata.revision,
        revision,
      });
    }
    if (revisions.length !== manifest.recordings)
      throw new Error("Backup recording count differs");
    const reports = await Reports.open(join(server, "reports.json"));
    try {
      await reports.reconcileRestore(revisions);
    } finally {
      await reports.close();
    }
    await atomicJson(join(output, "restore.json"), {
      version: 1,
      restoredAt: new Date().toISOString(),
      revisions,
    });
    async function syncTree(directory: string) {
      options.signal.throwIfAborted();
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await syncTree(join(directory, entry.name));
      await syncDirectory(directory);
    }
    await syncTree(output);
    options.signal.throwIfAborted();
    await unlink(join(server, ".restore-in-progress"));
    await syncDirectory(server);
    await syncDirectory(dirname(output));
    return { output, recordings: revisions.length, revisions };
  } catch (error) {
    await lock?.release();
    lock = undefined;
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await lock?.release();
  }
}
