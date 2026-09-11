import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PublisherJournal,
  PublisherNetwork,
  rotatePublisherCredential,
} from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";

it("rotates/revokes durably with owner authorization, retry fencing and active-lease invalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publisher-keys-"));
  const owner = "a".repeat(64),
    writer = "b".repeat(64),
    replacement = "c".repeat(64);
  let server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    let session = await server.store.create({
      ownerId: "local",
      requestId: "create",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: writer,
      title: "Credential test",
      visibility: "private",
    });
    const streamId = session.info.id,
      revision = session.info.revision;
    const resume = {
      publisherId: "pub",
      producerEpoch: "epoch",
      revision,
      attempt: 1,
    };
    const { lease } = await session.resume(writer, resume);
    const endpoint = () =>
      `${server.url}/api/v1/streams/${streamId}/publisher-credential`;
    const request = (secret: string, body?: unknown) =>
      fetch(endpoint(), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const change = {
      operationId: "rotate-1",
      revision,
      expectedVersion: 0,
      replacementSecret: replacement,
    };
    expect((await request(writer, change)).status).toBe(401);
    expect((await request(owner)).status).toBe(200);
    const rotated = await request(owner, change);
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ version: 1, revoked: false });
    expect((await request(owner, change)).status).toBe(200);
    await expect(session.resume(writer, resume)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(session.append(lease, [])).rejects.toMatchObject({
      code: "stale_lease",
    });
    const current = await session.resume(replacement, {
      ...resume,
      attempt: 2,
    });
    const revoke = {
      operationId: "revoke-1",
      revision,
      expectedVersion: 1,
      replacementSecret: null,
    };
    // Failed durable replacement must leave both credential and lease valid.
    const save = vi
      .spyOn(session as unknown as { save: () => Promise<void> }, "save")
      .mockRejectedValueOnce(new Error("disk failure"));
    await expect(session.changePublisherCredential(revoke)).rejects.toThrow(
      "disk failure",
    );
    save.mockRestore();
    expect(() => session.authorize(replacement)).not.toThrow();
    expect(
      (await session.resume(replacement, { ...resume, attempt: 2 })).lease,
    ).toEqual(current.lease);
    // Queue a resume behind revocation: the pre-queue credential check must not bypass it.
    const revoked = session.changePublisherCredential(revoke);
    const staleResume = session.resume(replacement, { ...resume, attempt: 3 });
    await revoked;
    await expect(staleResume).rejects.toMatchObject({ code: "unauthorized" });
    await expect(session.append(current.lease, [])).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect((await request(owner, revoke)).status).toBe(200);
    expect((await request(owner, change)).status).toBe(409);
    const disk = await readFile(
      join(session.directory, "metadata.json"),
      "utf8",
    );
    expect(disk).not.toContain(writer);
    expect(disk).not.toContain(replacement);
    expect(JSON.stringify(session.info)).not.toContain("publisherCredential");
    server.store.release(session);
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    session = await server.store.get(streamId);
    expect(session.publisherCredentialState).toMatchObject({
      version: 2,
      revoked: true,
    });
    await expect(session.resume(replacement, resume)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect((await request(owner, revoke)).status).toBe(200);
    const restored = await request(owner, {
      ...change,
      operationId: "rotate-2",
      expectedVersion: 2,
      replacementSecret: "d".repeat(64),
    });
    expect(restored.status).toBe(200);
    expect(() => session.authorize("d".repeat(64))).not.toThrow();
    server.store.release(session);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers a lost rotation response using the persisted replacement through the actual CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-rotate-cli-"));
  const owner = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: owner,
    port: 0,
  });
  let journal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: server.url,
    agent: "synthetic",
    nativeSessionId: "rotation",
  });
  const signal = new AbortController().signal;
  try {
    await new PublisherNetwork({
      journal,
      ownerCredential: owner,
      title: "Rotate",
      visibility: "private",
    }).ensureRemote(signal);
    const original = journal.identity;
    const directory = journal.directory;
    await journal.close();
    await expect(
      rotatePublisherCredential({
        directory,
        ownerCredential: owner,
        signal,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "POST") {
            expect(response.status).toBe(200);
            await response.arrayBuffer();
            throw new Error("Lost rotation response");
          }
          return response;
        },
      }),
    ).rejects.toThrow("Lost rotation response");
    journal = await PublisherJournal.openExisting(directory);
    expect(journal.identity.writeSecret).toBe(original.writeSecret);
    const pending = journal.identity.pendingCredentialRotation!;
    expect(pending.replacementSecret).toMatch(/^[a-f0-9]{64}$/);
    const copied = journal.identity;
    copied.pendingCredentialRotation!.replacementSecret = "e".repeat(64);
    expect(journal.identity.pendingCredentialRotation!.replacementSecret).toBe(
      pending.replacementSecret,
    );
    await expect(
      new PublisherNetwork({ journal }).ensureRemote(signal),
    ).rejects.toThrow("pending publisher credential rotation");
    await journal.close();
    const run = promisify(execFile);
    const command = (args: string[]) =>
      run(process.execPath, ["packages/cli/dist/main.js", ...args], {
        env: { ...process.env, AGENTLIVE_OWNER_SECRET: owner },
        timeout: 10000,
      });
    const rotated = await command([
      "rotate-publisher-credential",
      "--source",
      directory,
    ]);
    expect(JSON.parse(rotated.stdout)).toMatchObject({
      version: 1,
      revoked: false,
    });
    expect(rotated.stdout + rotated.stderr).not.toContain(
      pending.replacementSecret,
    );
    journal = await PublisherJournal.openExisting(directory);
    expect(journal.identity.writeSecret).toBe(pending.replacementSecret);
    expect(journal.identity.pendingCredentialRotation).toBeUndefined();
    expect(journal.identity.acknowledgedSeq).toBe(original.acknowledgedSeq);
    const session = await server.store.get(original.streamId!);
    expect(() => session.authorize(original.writeSecret)).toThrow();
    const { lease } = await session.resume(journal.identity.writeSecret, {
      publisherId: original.publisherId,
      producerEpoch: original.producerEpoch,
      revision: original.revision!,
      attempt: await journal.nextConnectionAttempt(),
    });
    const events = await journal.capture({
      sourceKey: "after-rotation",
      content: [
        {
          kind: "message.started",
          payload: { messageId: "m", role: "assistant" },
        },
      ],
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock",
      elapsedMs: 0,
      fidelity: "delta",
      adapterState: null,
    });
    expect((await session.append(lease, events)).throughProducerSeq).toBe(1);
    const base = ["--server", server.url, "--stream", original.streamId!];
    const state = JSON.parse(
      (await command(["publisher-credential", ...base])).stdout,
    );
    const revoke = [
      "revoke-publisher-credential",
      ...base,
      "--revision",
      state.revision,
      "--expected-version",
      String(state.version),
      "--operation-id",
      "revoke-cli",
    ];
    expect(JSON.parse((await command(revoke)).stdout)).toMatchObject({
      version: 2,
      revoked: true,
    });
    expect(JSON.parse((await command(revoke)).stdout)).toMatchObject({
      version: 2,
      revoked: true,
    });
    expect(() => session.authorize(journal.identity.writeSecret)).toThrow();
    await journal.close();
    await expect(
      rotatePublisherCredential({
        directory,
        ownerCredential: owner,
        signal,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "POST") {
            await response.arrayBuffer();
            throw new Error("Lost again");
          }
          return response;
        },
      }),
    ).rejects.toThrow("Lost again");
    await session.changePublisherCredential({
      operationId: "intervening-revoke",
      revision: original.revision!,
      expectedVersion: 3,
      replacementSecret: null,
    });
    await expect(
      command(["rotate-publisher-credential", "--source", directory]),
    ).rejects.toThrow();
    const restarted = await command([
      "rotate-publisher-credential",
      "--source",
      directory,
      "--restart-rotation",
    ]);
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      version: 5,
      revoked: false,
    });
    journal = await PublisherJournal.openExisting(directory);
    expect(() => session.authorize(journal.identity.writeSecret)).not.toThrow();
    server.store.release(session);
  } finally {
    await journal.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
