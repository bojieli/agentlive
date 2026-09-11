import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "../../packages/server/src/store.js";

it("persists owner-authorized removal, fences old create retries, and fills listing pages across tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-removal-"));
  let store = await RecordingStore.open(root);
  try {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const request = {
        ownerId: "owner",
        requestId: `request-${i}`,
        requestedAt: new Date().toISOString(),
        publisherId: "publisher",
        producerEpoch: "epoch",
        writeSecret: "a".repeat(64),
        title: `Recording ${i}`,
        visibility: "public" as const,
      };
      const session = await store.create(request);
      entries.push({
        request,
        session,
        id: session.info.id,
        revision: session.info.revision,
      });
      store.release(session);
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const target = entries[0]!;
    const input = {
      id: target.id,
      revision: target.revision,
      operationId: "remove-one",
      ownerId: "owner",
    };
    const reader = target.session.acquirePublicRead()!;
    await expect(
      store.remove({ ...input, ownerId: "other" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      store.remove({ ...input, revision: "wrong" }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(reader.signal.aborted).toBe(false);
    const invalidated = vi.fn();
    await target.session.subscribe({ deliver() {}, invalidate: invalidated });
    const result = await store.remove(input);
    expect(invalidated).toHaveBeenCalledWith("recording_removed");
    await expect(
      target.session.subscribe({ deliver() {}, invalidate() {} }),
    ).rejects.toMatchObject({ code: "stream_gone" });
    expect(result.removed).toBe(true);
    expect(reader.signal.aborted).toBe(true);
    expect(() => target.session.assertAvailable()).toThrow("removed");
    expect(target.session.info).not.toHaveProperty("removed");
    await expect(store.get(target.id)).rejects.toMatchObject({
      code: "stream_gone",
    });
    await expect(store.create(target.request)).rejects.toMatchObject({
      code: "stream_gone",
    });
    expect(await store.remove(input)).toEqual(result);
    for (let restart = 0; restart < 2; restart++) {
      const owned = await store.list({ ownerId: "owner", limit: 2 });
      const publicPage = await store.listPublic({ limit: 2 });
      expect(owned.recordings.map((row) => row.id)).toEqual(
        entries.slice(1, 3).map((row) => row.id),
      );
      expect(publicPage.recordings.map((row) => row.id)).toEqual(
        owned.recordings.map((row) => row.id),
      );
      expect(owned.nextAfter).toBe(entries[2]!.id);
      await store.close();
      store = await RecordingStore.open(root);
      await expect(store.get(target.id)).rejects.toMatchObject({
        code: "stream_gone",
      });
      await expect(store.create(target.request)).rejects.toMatchObject({
        code: "stream_gone",
      });
      expect(await store.remove(input)).toEqual(result);
      await expect(
        store.remove({ ...input, ownerId: "other" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("removal HTTP endpoint denies publishers and anonymous callers and supports retries after restart", async () => {
  const { startServer } = await import("../../packages/server/src/http.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-remove-http-"));
  const owner = "c".repeat(64),
    writer = "d".repeat(64);
  let server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "request",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: writer,
      title: "Private",
      visibility: "private",
    });
    const { id, revision } = session.info;
    const access = session.acquireRead();
    const { viewingResponse } =
      await import("../../packages/server/src/viewing-response.js");
    let cancelled = false;
    const response = viewingResponse(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
      access,
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    server.store.release(session);
    const remove = (credential: string) =>
      fetch(`${server.url}/api/v1/recordings/${id}/removal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify({ revision, operationId: "remove" }),
      });
    expect((await remove(writer)).status).toBe(401);
    expect((await remove("")).status).toBe(401);
    expect(access.signal.aborted).toBe(false);
    const result = await remove(owner);
    expect(result.status).toBe(200);
    const receipt = await result.json();
    await expect(reader.read()).rejects.toThrow("unavailable");
    expect(cancelled).toBe(true);
    expect(
      (
        await fetch(`${server.url}/api/v1/streams/${id}`, {
          headers: { authorization: `Bearer ${owner}` },
        })
      ).status,
    ).toBe(404);
    expect(await (await remove(owner)).json()).toEqual(receipt);
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    expect(await (await remove(owner)).json()).toEqual(receipt);
    expect((await remove(writer)).status).toBe(401);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires explicit CLI confirmation and preserves removal receipts on command retries", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { startServer } = await import("../../packages/server/src/http.js");
  const run = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "agentlive-remove-cli-"));
  const owner = "e".repeat(64);
  const server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "cli-removal",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "f".repeat(64),
      title: "CLI removal",
      visibility: "private",
    });
    const { id, revision } = session.info;
    server.store.release(session);
    const command = (confirm: boolean) =>
      run(
        process.execPath,
        [
          "packages/cli/dist/main.js",
          "remove",
          "--server",
          server.url,
          "--stream",
          id,
          "--revision",
          revision,
          "--operation-id",
          "remove-cli",
          ...(confirm ? ["--confirm-removal"] : []),
        ],
        {
          env: { ...process.env, AGENTLIVE_OWNER_SECRET: owner },
          timeout: 10000,
        },
      );
    await expect(command(false)).rejects.toMatchObject({
      stderr: expect.stringContaining("--confirm-removal"),
    });
    const present = await server.store.get(id);
    server.store.release(present);
    const result = await command(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      streamId: id,
      removed: true,
    });
    expect((await command(true)).stdout).toBe(result.stdout);
    expect(result.stdout + result.stderr).not.toContain(owner);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("drains held sessions before cleanup and resumes interrupted cleanup through backup and restore", async () => {
  const { readdir, writeFile, mkdir } = await import("node:fs/promises");
  const { backupServer } = await import("../../packages/server/src/backup.js");
  const { restoreServer } =
    await import("../../packages/server/src/restore.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-remove-cleanup-"));
  const directory = join(root, "server");
  let store = await RecordingStore.open(directory);
  try {
    const request = {
      ownerId: "local",
      requestId: "cleanup",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "a".repeat(64),
      title: "Cleanup",
      visibility: "private" as const,
    };
    const session = await store.create(request);
    const { id, revision } = session.info;
    const path = join(directory, "sessions", id);
    const input = { id, revision, operationId: "cleanup", ownerId: "local" };
    const receipt = await store.remove(input);
    expect(await readdir(path)).toContain("events.jsonl");
    store.release(session);
    // A serialized retry drains the queued cleanup and acknowledges the same intent.
    expect(await store.remove(input)).toEqual(receipt);
    expect(await readdir(path)).toEqual(["metadata.json"]);
    await store.close();
    // Emulate a crash after tombstone durability but before all data was removed.
    await mkdir(join(path, "attachments"));
    await writeFile(join(path, "attachments", "leftover"), "private data");
    await writeFile(join(path, "events.jsonl"), "partial data");
    store = await RecordingStore.open(directory);
    expect(await readdir(path)).toEqual(["metadata.json"]);
    await expect(store.create(request)).rejects.toMatchObject({
      code: "stream_gone",
    });
    await store.close();
    const ownerFile = join(root, "owner.json");
    await writeFile(
      ownerFile,
      JSON.stringify({ version: 1, secret: "b".repeat(64) }),
      { mode: 0o600 },
    );
    const signal = AbortSignal.timeout(20000);
    await backupServer({
      directory,
      ownerFile,
      output: join(root, "backup"),
      signal,
    });
    await restoreServer({
      source: join(root, "backup"),
      output: join(root, "restored"),
      signal,
    });
    store = await RecordingStore.open(join(root, "restored", "server"));
    expect(await store.remove(input)).toEqual(receipt);
    await expect(store.create(request)).rejects.toMatchObject({
      code: "stream_gone",
    });
    expect(
      await readdir(join(root, "restored", "server", "sessions", id)),
    ).toEqual(["metadata.json"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const persisted of [false, true])
  it(`fences uncertain removal persistence (replacement installed: ${persisted})`, async () => {
    const { atomicJson } = await import("../../packages/storage/src/index.js");
    const root = await mkdtemp(join(tmpdir(), "agentlive-remove-uncertain-"));
    let store = await RecordingStore.open(root);
    try {
      const session = await store.create({
        ownerId: "local",
        requestId: "uncertain",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "a".repeat(64),
        title: "Uncertain",
        visibility: "private",
      });
      const { id, revision } = session.info;
      const read = session.acquireRead();
      store.release(session);
      const save = vi
        .spyOn(
          session as unknown as { save: (metadata: unknown) => Promise<void> },
          "save",
        )
        .mockImplementationOnce(async (metadata) => {
          if (persisted)
            await atomicJson(
              join(root, "sessions", id, "metadata.json"),
              metadata,
            );
          throw new Error("disk failure");
        });
      await expect(
        store.remove({
          id,
          revision,
          operationId: "uncertain",
          ownerId: "local",
        }),
      ).rejects.toThrow("disk failure");
      save.mockRestore();
      expect(read.signal.aborted).toBe(true);
      await expect(store.get(id)).rejects.toMatchObject({
        code: "storage_failed",
      });
      await store.close();
      store = await RecordingStore.open(root);
      if (persisted)
        await expect(store.get(id)).rejects.toMatchObject({
          code: "stream_gone",
        });
      else {
        const recovered = await store.get(id);
        store.release(recovered);
        expect(
          (
            await store.remove({
              id,
              revision,
              operationId: "uncertain",
              ownerId: "local",
            })
          ).removed,
        ).toBe(true);
      }
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
