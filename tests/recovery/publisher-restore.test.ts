import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../packages/server/src/http.js";
import { backupServer } from "../../packages/server/src/backup.js";
import { restoreServer } from "../../packages/server/src/restore.js";
import {
  PublisherJournal,
  PublisherNetwork,
  ArtifactSpool,
  recoverPublisher,
} from "../../packages/publisher/src/index.js";
it("recovers a rolled-back publisher ACK, uploads lost attachments and republishes the exact suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publisher-restore-"));
  const secret = "a".repeat(64),
    state = join(root, "state"),
    ownerFile = join(state, "owner.json");
  let server = await startServer({
    directory: join(state, "server"),
    ownerSecret: secret,
    port: 0,
  });
  const origin = server.url,
    port = Number(new URL(origin).port);
  const signal = AbortSignal.timeout(20000);
  const binding = {
    serverOrigin: origin,
    agent: "synthetic" as const,
    nativeSessionId: "restore",
  };
  const publisherRoot = join(root, "publisher");
  let journal = await PublisherJournal.open(publisherRoot, binding);
  let artifacts: ArtifactSpool | undefined;
  let running: Promise<void> | undefined;
  const stop = new AbortController();
  try {
    await writeFile(ownerFile, JSON.stringify({ version: 1, secret }), {
      mode: 0o600,
    });
    const network = new PublisherNetwork({
      journal,
      ownerCredential: secret,
      title: "Recovery",
      visibility: "private",
    });
    await network.ensureRemote(signal);
    const session = await server.store.get(journal.identity.streamId!);
    const { lease } = await session.resume(journal.identity.writeSecret, {
      publisherId: journal.identity.publisherId,
      producerEpoch: journal.identity.producerEpoch,
      revision: journal.identity.revision!,
      attempt: await journal.nextConnectionAttempt(),
    });
    const capture = (sourceKey: string, content: any[]) =>
      journal.capture({
        sourceKey,
        content,
        observedAt: "2026-09-10T00:00:00Z",
        clockSegmentId: "clock",
        elapsedMs: 0,
        fidelity: "delta",
        adapterState: { sourceKey },
      });
    const first = await capture("first", [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
    ]);
    await session.append(lease, first);
    await journal.acknowledge(1);
    server.store.release(session);
    await server.close();
    const backup = join(root, "backup");
    await backupServer({
      directory: join(state, "server"),
      ownerFile,
      output: backup,
      signal,
    });
    const bytes = Buffer.from("restored suffix attachment");
    artifacts = await ArtifactSpool.open(
      join(journal.directory, "artifacts", "capture"),
      { allowedRoots: [] },
    );
    const attachment = await artifacts.captureInline(
      {
        artifactId: "a",
        sourceKey: "a",
        bytes,
        filename: "a.txt",
        mediaType: "text/plain",
        text: true,
        historical: true,
      },
      signal,
    );
    await artifacts.close();
    artifacts = undefined;
    const suffix = await capture("second", [
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: "Recovered suffix" },
      },
      { kind: "attachment.available", payload: { attachment } },
    ]);
    server = await startServer({
      directory: join(state, "server"),
      ownerSecret: secret,
      port,
    });
    const continued = await server.store.get(journal.identity.streamId!);
    const resumed = await continued.resume(journal.identity.writeSecret, {
      publisherId: journal.identity.publisherId,
      producerEpoch: journal.identity.producerEpoch,
      revision: journal.identity.revision!,
      attempt: await journal.nextConnectionAttempt(),
    });
    await continued.uploadAttachment(
      journal.identity.writeSecret,
      attachment,
      (async function* () {
        yield bytes;
      })(),
      signal,
    );
    await continued.append(resumed.lease, suffix);
    await journal.acknowledge(3);
    server.store.release(continued);
    await server.close();
    const journalDirectory = journal.directory;
    const previousRevision = journal.identity.revision;
    await journal.close();
    const restored = join(root, "restored");
    await restoreServer({ source: backup, output: restored, signal });
    server = await startServer({
      directory: join(restored, "server"),
      ownerSecret: secret,
      port,
    });
    const before = await readFile(join(journalDirectory, "binding.json"));
    const protectedState = await fetch(
      `${origin}/api/v1/streams/${JSON.parse(before.toString()).streamId}/publisher-state`,
      { signal },
    );
    expect(protectedState.status).toBe(401);

    let divergent = await PublisherJournal.open(
      join(root, "divergent"),
      binding,
    );
    const divergentDirectory = divergent.directory;
    await divergent.close();
    const identityCopy = JSON.parse(before.toString());
    identityCopy.acknowledgedSeq = 0;
    await writeFile(
      join(divergentDirectory, "binding.json"),
      JSON.stringify(identityCopy),
    );
    divergent = await PublisherJournal.open(join(root, "divergent"), binding);
    await divergent.capture({
      sourceKey: "different",
      content: [
        {
          kind: "message.started",
          payload: { messageId: "different", role: "assistant" },
        },
      ],
      observedAt: "2026-09-10T00:00:00Z",
      clockSegmentId: "clock",
      elapsedMs: 0,
      fidelity: "delta",
      adapterState: null,
    });
    await divergent.close();
    const divergentBefore = await readFile(
      join(divergentDirectory, "binding.json"),
    );
    await expect(
      recoverPublisher({ directory: divergentDirectory, signal }),
    ).rejects.toMatchObject({ code: "event_conflict" });
    expect(await readFile(join(divergentDirectory, "binding.json"))).toEqual(
      divergentBefore,
    );

    const blob = join(
      journalDirectory,
      "artifacts",
      "capture",
      "blobs",
      attachment.hash,
    );
    await writeFile(blob, "wrong");
    await expect(
      recoverPublisher({ directory: journalDirectory, signal }),
    ).rejects.toThrow();
    expect(await readFile(join(journalDirectory, "binding.json"))).toEqual(
      before,
    );
    await writeFile(blob, bytes);
    const command = await promisify(execFile)(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "recover-publisher",
        "--source",
        journalDirectory,
      ],
      { timeout: 10000 },
    );
    const recovered = JSON.parse(command.stdout);
    expect(recovered.event).toBe("publisher-recovered");
    expect(command.stdout).not.toContain(
      JSON.parse(before.toString()).writeSecret,
    );
    expect(recovered).toMatchObject({
      previousRevision,
      acknowledgedSeq: 1,
      previousAcknowledgedSeq: 3,
      pendingEvents: 2,
      uploadedAttachments: 1,
    });
    journal = await PublisherJournal.open(publisherRoot, binding);
    expect(journal.identity.revision).toBe(recovered.revision);
    running = new PublisherNetwork({
      journal,
      title: "Recovery",
      visibility: "private",
    }).run(stop.signal);
    await expect
      .poll(() => journal.identity.acknowledgedSeq, { timeout: 10000 })
      .toBe(3);
    stop.abort();
    await running;
    const replay = await server.store.get(recovered.streamId);
    const events = await Array.fromAsync(
      replay.history(0, replay.boundary.sequence),
    );
    expect(
      events
        .filter((event) => event.origin.type === "publisher")
        .map(
          (event) =>
            event.origin.type === "publisher" && event.origin.event.producerSeq,
        ),
    ).toEqual([1, 2, 3]);
    expect(
      events.some(
        (event) =>
          event.content.kind === "message.text.append" &&
          event.content.payload.text === "Recovered suffix",
      ),
    ).toBe(true);
    server.store.release(replay);
    await journal.close();
    await expect(
      recoverPublisher({ directory: journalDirectory, signal }),
    ).rejects.toThrow("unchanged");
  } finally {
    stop.abort();
    await running?.catch(() => {});
    await artifacts?.close();
    await journal.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
