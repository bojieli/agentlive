import { it, expect } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RecordingStore } from "../../packages/server/src/store.js";
import { restoreServer } from "../../packages/server/src/restore.js";
import { backupServer } from "../../packages/server/src/backup.js";
const run = promisify(execFile);
it("backs up credentials and validated recording state, refuses live ownership and preserves originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-backup-"));
  const state = join(root, "state"),
    directory = join(state, "server"),
    ownerFile = join(state, "owner.json"),
    output = join(root, "backup");
  let store = await RecordingStore.open(directory);
  const signal = AbortSignal.timeout(20000);
  try {
    await writeFile(
      ownerFile,
      JSON.stringify({ version: 1, secret: "a".repeat(64) }),
      { mode: 0o600 },
    );
    const session = await store.create({
      ownerId: "local",
      requestId: "backup",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret: "b".repeat(64),
      visibility: "private",
      title: "Backup fixture",
    });
    const id = session.info.id;
    const attachmentBytes = Buffer.from("backup attachment bytes");
    const attachment = {
      artifactId: "file",
      version: 1,
      filename: "file.txt",
      mediaType: "text/plain",
      hash: createHash("sha256").update(attachmentBytes).digest("hex"),
      byteSize: attachmentBytes.length,
    };
    await session.uploadAttachment(
      "b".repeat(64),
      attachment,
      (async function* () {
        yield attachmentBytes;
      })(),
    );
    const { lease } = await session.resume("b".repeat(64), {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 1,
      revision: session.info.revision,
    });
    await session.append(lease, [
      {
        protocolVersion: 1,
        streamId: id,
        producerEpoch: "e",
        producerSeq: 1,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock",
        elapsedMs: 0,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "backup" },
        content: { kind: "attachment.available", payload: { attachment } },
      },
    ]);
    await session.buildSnapshot(session.boundary.sequence, signal);
    await expect(
      backupServer({ directory, ownerFile, output, signal }),
    ).rejects.toMatchObject({ code: "publisher_busy" });
    await store.close();
    const events = join(directory, "sessions", id, "events.jsonl");
    const original = await readFile(events);
    const metadata = await readFile(
      join(directory, "sessions", id, "metadata.json"),
    );
    const result = await backupServer({ directory, ownerFile, output, signal });
    expect(result.recordings).toBe(1);
    expect(await readFile(events)).toEqual(original);
    expect(
      await readFile(join(directory, "sessions", id, "metadata.json")),
    ).toEqual(metadata);
    const manifest = JSON.parse(
      await readFile(join(output, "backup.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      format: "agentlive.server-backup",
      version: 1,
      recordings: 1,
    });
    expect(manifest.files.some((file: any) => file.path === "owner.json")).toBe(
      true,
    );
    for (const file of manifest.files) {
      const bytes = await readFile(join(output, file.path));
      expect(bytes.length).toBe(file.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.hash);
      expect((await stat(join(output, file.path))).mode & 0o077).toBe(0);
    }
    const restoredPath = join(root, "restored");
    const restored = await restoreServer({
      source: output,
      output: restoredPath,
      signal,
    });
    expect(restored.recordings).toBe(1);
    expect(restored.revisions[0]!.previousRevision).toBe(session.info.revision);
    expect(restored.revisions[0]!.revision).not.toBe(session.info.revision);
    expect(
      await readFile(
        join(restoredPath, "server", "sessions", id, "events.jsonl"),
      ),
    ).toEqual(original);
    expect(await readFile(join(restoredPath, "owner.json"))).toEqual(
      await readFile(ownerFile),
    );
    const restoredStore = await RecordingStore.open(
      join(restoredPath, "server"),
    );
    try {
      const recovered = await restoredStore.get(id);
      expect(recovered.info.revision).toBe(restored.revisions[0]!.revision);
      expect(
        await recovered.selectSnapshot(recovered.boundary.sequence, signal),
      ).toBeNull();
      await expect(
        recovered.resume("b".repeat(64), {
          publisherId: "p",
          producerEpoch: "e",
          attempt: 2,
          revision: session.info.revision,
        }),
      ).rejects.toMatchObject({ code: "revision_changed" });
      await recovered.resume("b".repeat(64), {
        publisherId: "p",
        producerEpoch: "e",
        attempt: 2,
        revision: recovered.info.revision,
      });
      restoredStore.release(recovered);
    } finally {
      await restoredStore.close();
    }
    const { startServer } = await import("../../packages/server/src/http.js");
    const restoredHttp = await startServer({
      directory: join(restoredPath, "server"),
      ownerSecret: "a".repeat(64),
      port: 0,
    });
    try {
      const { openRecordingHistory } =
        await import("../../packages/client/src/index.js");
      const history = await openRecordingHistory({
        serverOrigin: restoredHttp.url,
        streamId: id,
        credential: "a".repeat(64),
        signal,
      });
      expect(history.metadata.revision).toBe(restored.revisions[0]!.revision);
      expect((await Array.fromAsync(history.events)).length).toBe(
        session.boundary.sequence,
      );
      const stale = await fetch(
        `${restoredHttp.url}/api/v1/streams/${id}/events?revision=${session.info.revision}&afterServerSeq=0&throughServerSeq=${session.boundary.sequence}&limit=50`,
        { headers: { authorization: `Bearer ${"a".repeat(64)}` }, signal },
      );
      expect(stale.status).toBe(409);
    } finally {
      await restoredHttp.close();
    }
    await expect(
      restoreServer({ source: output, output: restoredPath, signal }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const blocked = join(root, "blocked");
    await import("node:fs/promises").then((fs) => fs.mkdir(blocked));
    await writeFile(join(blocked, ".restore-in-progress"), "{}");
    await expect(RecordingStore.open(blocked)).rejects.toThrow("incomplete");
    const manifestPath = join(output, "backup.json");
    const originalManifest = await readFile(manifestPath);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        files: [
          ...manifest.files,
          { path: "../escape", hash: "a".repeat(64), byteSize: 0 },
        ],
      }),
    );
    await expect(
      restoreServer({
        source: output,
        output: join(root, "traversal"),
        signal,
      }),
    ).rejects.toThrow("Unsafe");
    await writeFile(manifestPath, originalManifest);
    const backupAttachment = join(
      output,
      "server",
      "sessions",
      id,
      "attachments",
      attachment.hash,
    );
    await writeFile(backupAttachment, "corrupt");
    await expect(
      restoreServer({
        source: output,
        output: join(root, "bad-restore"),
        signal,
      }),
    ).rejects.toThrow("size differs");
    expect(await readdir(root)).not.toContain("bad-restore");
    await writeFile(backupAttachment, attachmentBytes);
    await symlink(ownerFile, join(output, "unlisted-link"));
    await expect(
      restoreServer({
        source: output,
        output: join(root, "linked-restore"),
        signal,
      }),
    ).rejects.toThrow("links");
    await rm(join(output, "unlisted-link"));

    await expect(
      backupServer({ directory, ownerFile, output, signal }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(
      JSON.parse(await readFile(join(output, "backup.json"), "utf8")),
    ).toEqual(manifest);
    const env = { ...process.env };
    delete env.AGENTLIVE_OWNER_SECRET;
    const cli = await run(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "backup",
        "--state-dir",
        state,
        "--output",
        join(root, "cli-backup"),
      ],
      { env },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({
      event: "backup",
      recordings: 1,
    });
    expect(cli.stdout).not.toContain("a".repeat(64));
    await expect(
      backupServer({
        directory,
        ownerFile,
        output: join(directory, "nested"),
        signal,
      }),
    ).rejects.toThrow("outside");
    await symlink(ownerFile, join(directory, "linked-secret"));
    await expect(
      backupServer({
        directory,
        ownerFile,
        output: join(root, "unsafe"),
        signal,
      }),
    ).rejects.toThrow("symbolic");
    expect(await readdir(root)).not.toContain("unsafe");
    await rm(join(directory, "linked-secret"));
    const attachmentPath = join(
      directory,
      "sessions",
      id,
      "attachments",
      attachment.hash,
    );
    await writeFile(attachmentPath, "corrupt attachment");
    await expect(
      backupServer({
        directory,
        ownerFile,
        output: join(root, "bad-attachment"),
        signal,
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).not.toContain("bad-attachment");
    await writeFile(attachmentPath, attachmentBytes);
    await writeFile(events, Buffer.from("corrupt\n"));
    await expect(
      backupServer({
        directory,
        ownerFile,
        output: join(root, "corrupt"),
        signal,
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).not.toContain("corrupt");
    expect((await readFile(events)).toString()).toBe("corrupt\n");
    const stop = new AbortController();
    stop.abort(new Error("cancel backup"));
    await expect(
      backupServer({
        directory,
        ownerFile,
        output: join(root, "cancelled"),
        signal: stop.signal,
      }),
    ).rejects.toThrow("cancel backup");
    expect(await readdir(root)).not.toContain("cancelled");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
