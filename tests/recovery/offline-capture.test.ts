import { afterEach, expect, it } from "vitest";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArtifactSpool,
  PublisherJournal,
  UNBOUND_STREAM_ID,
  type CaptureInput,
} from "../../packages/publisher/src/index.js";
import { localArtifactResolver } from "../../packages/adapters/src/index.js";
import { publishClaudeRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";

const roots: string[] = [];
const open: PublisherJournal[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  for (const journal of open.splice(0)) await journal.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close().catch(() => {});
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function root(label: string) {
  const path = await mkdtemp(join(tmpdir(), `agentlive-offline-${label}-`));
  roots.push(path);
  return path;
}
const identity = {
  serverOrigin: "https://example.test",
  agent: "synthetic" as const,
  nativeSessionId: "native_1",
};
function capture(n: number): CaptureInput {
  return {
    sourceKey: `source_${n}`,
    observedAt: "2026-09-10T00:00:00.000Z",
    clockSegmentId: "clock_1",
    elapsedMs: n,
    fidelity: "delta",
    adapterState: { cursor: n },
    content: [
      {
        kind: "message.text.append",
        payload: { messageId: `m${n}`, text: `text ${n}` },
      },
    ],
  };
}
async function opened(path: string) {
  const journal = await PublisherJournal.open(path, identity);
  open.push(journal);
  return journal;
}

it("journals events before a remote binding exists and binds them when it appears", async () => {
  const path = await root("journal");
  const journal = await opened(path);
  expect(journal.identity.streamId).toBeNull();
  const first = await journal.capture(capture(1));
  const second = await journal.capture(capture(2));
  // Events exist durably with a placeholder identity and real producer sequences.
  expect(first[0]!.streamId).toBe(UNBOUND_STREAM_ID);
  expect([...first, ...second].map((event) => event.producerSeq)).toEqual([
    1, 2,
  ]);
  expect(journal.capturedThrough).toBe(2);
  const unbound = [];
  for await (const event of journal.pending(0)) unbound.push(event);
  expect(unbound.map((event) => event.streamId)).toEqual([
    UNBOUND_STREAM_ID,
    UNBOUND_STREAM_ID,
  ]);

  await journal.bindRemote("stream_1", "revision_1");
  const bound = [];
  for await (const event of journal.pending(0)) bound.push(event);
  expect(bound.map((event) => event.streamId)).toEqual([
    "stream_1",
    "stream_1",
  ]);
  // Binding changes nothing else about the already-captured events.
  expect(bound.map(({ streamId: _, ...rest }) => rest)).toEqual(
    unbound.map(({ streamId: _, ...rest }) => rest),
  );
  // Capture after binding continues the same sequence with the real identity.
  expect((await journal.capture(capture(3)))[0]).toMatchObject({
    producerSeq: 3,
    streamId: "stream_1",
  });
  // A replayed unbound source key still deduplicates, now bound.
  expect(await journal.capture(capture(1))).toEqual([bound[0]]);
});

it("keeps unbound capture across a publisher restart and refuses a placeholder binding", async () => {
  const path = await root("restart");
  let journal = await opened(path);
  await journal.capture(capture(1));
  const epoch = journal.identity.producerEpoch;
  const secret = journal.identity.writeSecret;
  await journal.close();
  open.length = 0;

  journal = await opened(path);
  expect(journal.identity.streamId).toBeNull();
  expect(journal.identity.producerEpoch).toBe(epoch);
  expect(journal.identity.writeSecret).toBe(secret);
  expect(journal.capturedThrough).toBe(1);
  expect(journal.checkpoint).toEqual({ cursor: 1 });
  expect((await journal.capture(capture(2)))[0]).toMatchObject({
    producerSeq: 2,
    producerEpoch: epoch,
    streamId: UNBOUND_STREAM_ID,
  });
  await expect(
    journal.bindRemote(UNBOUND_STREAM_ID, "revision_1"),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(journal.identity.streamId).toBeNull();
  await journal.bindRemote("stream_1", "revision_1");
  await journal.close();
  open.length = 0;

  // The durable records still carry the placeholder; reopening binds them again.
  journal = await opened(path);
  const raw = await readFile(join(journal.directory, "capture.jsonl"), "utf8");
  expect(raw).toContain(`"streamId":"${UNBOUND_STREAM_ID}"`);
  const events = [];
  for await (const event of journal.pending(0)) events.push(event);
  expect(events.map((event) => event.streamId)).toEqual([
    "stream_1",
    "stream_1",
  ]);
});

it("captures attachments while unbound and binds their events when the recording appears", async () => {
  const path = await root("artifacts");
  let journal = await opened(path);
  const spool = await ArtifactSpool.open(
    join(journal.directory, "artifacts", "capture"),
    { allowedRoots: [] },
  );
  const signal = new AbortController().signal;
  const attachment = await spool.captureInline(
    {
      artifactId: "a",
      sourceKey: "a",
      bytes: Buffer.from("captured while the server was unreachable"),
      filename: "a.txt",
      mediaType: "text/plain",
      text: true,
      historical: true,
    },
    signal,
  );
  await spool.close();
  await journal.capture({
    ...capture(1),
    content: [{ kind: "attachment.available", payload: { attachment } }],
  });
  await journal.close();
  open.length = 0;

  journal = await opened(path);
  await journal.bindRemote("stream_1", "revision_1");
  const events = [];
  for await (const event of journal.pending(0)) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]!.streamId).toBe("stream_1");
  expect(events[0]!.content).toEqual({
    kind: "attachment.available",
    payload: { attachment },
  });
  // The immutable bytes are still readable from the spool for upload/recovery.
  const reopened = await ArtifactSpool.open(
    join(journal.directory, "artifacts", "capture"),
    { allowedRoots: [] },
  );
  try {
    const file = await reopened.openFile(attachment);
    try {
      expect((await file.readFile()).toString()).toBe(
        "captured while the server was unreachable",
      );
    } finally {
      await file.close();
    }
  } finally {
    await reopened.close();
  }
});

it("captures artifact bytes immediately and defers only the upload until the recording binds", async () => {
  const path = await root("resolver");
  const server = await startServer({
    directory: join(path, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  servers.push(server);
  const journal = await opened(path);
  await writeFile(join(path, "note.txt"), "artifact captured offline");
  const resolver = await localArtifactResolver({
    directory: join(journal.directory, "artifacts"),
    roots: [path],
    baseDirectory: path,
    secrets: [],
    serverOrigin: server.url,
    streamId: () => journal.identity.streamId,
    writeSecret: journal.identity.writeSecret,
    signal: AbortSignal.timeout(20_000),
  });
  try {
    let settled = false;
    const resolving = resolver
      .resolveArtifact({
        artifactId: "artifact_1",
        sourceKey: "source_1",
        path: "note.txt",
        historical: true,
      })
      .finally(() => {
        settled = true;
      });
    // The capture checkpoint is written before any binding exists; only the
    // upload waits, so nothing is lost while the recording is missing.
    await expect
      .poll(async () =>
        (await readdir(join(journal.directory, "artifacts", "outcomes"))).some(
          (name) => name.endsWith(".json"),
        ),
      )
      .toBe(true);
    expect(settled).toBe(false);

    const created = await fetch(server.url + "/api/v1/streams", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"b".repeat(64)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: journal.identity.creationRequestId,
        requestedAt: journal.identity.creationTime,
        publisherId: journal.identity.publisherId,
        producerEpoch: journal.identity.producerEpoch,
        writeSecret: journal.identity.writeSecret,
        title: "Offline artifacts",
        visibility: "private",
      }),
    });
    const remote = (await created.json()) as {
      streamId: string;
      revision: string;
    };
    await journal.bindRemote(remote.streamId, remote.revision);
    const outcome = await resolving;
    expect(outcome).toHaveProperty("attachment");
    const attachment = (
      outcome as { attachment: { hash: string; byteSize: number } }
    ).attachment;
    const status = await fetch(
      `${server.url}/api/v1/streams/${remote.streamId}/attachments/${attachment.hash}/status?byteSize=${attachment.byteSize}`,
      { headers: { authorization: `Bearer ${journal.identity.writeSecret}` } },
    );
    expect(await status.json()).toEqual({ available: true });
  } finally {
    await resolver.close();
  }
});

it(
  "publishes with the server down, survives an unbound restart and delivers exactly once in order",
  { timeout: 60_000 },
  async () => {
    const path = await root("publish");
    const ownerCredential = "b".repeat(64);
    // Reserve a port by starting and stopping a server on it.
    const reserved = await startServer({
      directory: join(path, "server"),
      ownerSecret: ownerCredential,
      port: 0,
    });
    const origin = reserved.url;
    const port = Number(new URL(origin).port);
    await reserved.close();

    const sourcePath = join(path, "native.jsonl");
    const row = (uuid: string, text: string) =>
      JSON.stringify({
        uuid,
        type: "assistant",
        sessionId: "claude_offline",
        timestamp: "2026-09-09T00:00:00Z",
        message: { content: [{ type: "text", text }] },
      }) + "\n";
    await writeFile(sourcePath, row("a", "first") + row("b", "second"));
    const settings = {
      sourcePath,
      publisherRoot: join(path, "publisher"),
      serverOrigin: origin,
      ownerCredential,
      title: "Offline publish",
      visibility: "private" as const,
    };
    interface Attached {
      captured: number;
      ready: string | undefined;
    }
    const attach = async (until: (state: Attached) => Promise<boolean>) => {
      const controller = new AbortController();
      const state: Attached = { captured: 0, ready: undefined };
      let failure: unknown;
      const running = publishClaudeRecording({
        ...settings,
        signal: controller.signal,
        onReady: (recording) => {
          state.ready = recording.streamId;
        },
        onCaughtUp: async (boundary) => {
          state.captured = boundary.producerEvents;
        },
      }).catch((error) => {
        failure = error;
      });
      try {
        await expect
          .poll(
            async () => {
              if (failure) throw failure;
              return await until(state);
            },
            { timeout: 25_000, interval: 25 },
          )
          .toBe(true);
      } finally {
        controller.abort();
        await running;
      }
      // Detaching during setup surfaces the abort itself, which is not a failure.
      if (failure !== undefined && failure !== controller.signal.reason)
        throw failure;
      return state;
    };
    const bindingDirectory = async () => {
      const [name] = await readdir(settings.publisherRoot);
      return join(settings.publisherRoot, name!);
    };
    const bindingFile = async () =>
      JSON.parse(
        await readFile(join(await bindingDirectory(), "binding.json"), "utf8"),
      );

    // 1. The server does not exist yet; capture must still make progress.
    const offline = await attach(async (state) => {
      if (!state.captured) return false;
      expect((await bindingFile()).streamId).toBeNull();
      return true;
    });
    expect(offline.captured).toBeGreaterThan(0);
    expect(offline.ready).toBeUndefined();

    // 2. A restart while still unbound continues the same unbound journal.
    await appendFile(sourcePath, row("c", "third"));
    const restarted = await attach(
      async (state) => state.captured > offline.captured,
    );
    expect(restarted.ready).toBeUndefined();
    const directory = await bindingDirectory();
    const records = (await readFile(join(directory, "capture.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).value);
    expect(records.every((record) => record.unbound === true)).toBe(true);
    const offlineEvents: { producerSeq: number; streamId: string }[] =
      records.flatMap((record) => record.events);
    expect(offlineEvents).toHaveLength(restarted.captured);
    expect(offlineEvents.map((event) => event.producerSeq)).toEqual(
      offlineEvents.map((_, index) => index + 1),
    );
    expect(new Set(offlineEvents.map((event) => event.streamId))).toEqual(
      new Set([UNBOUND_STREAM_ID]),
    );

    // 3. The server comes back: the recording binds and the backlog drains once.
    const server = await startServer({
      directory: join(path, "server"),
      ownerSecret: ownerCredential,
      port,
    });
    servers.push(server);
    const delivered = await attach(async (state) => {
      if (!state.ready) return false;
      const session = await server.store.get(state.ready);
      let through = 0;
      for await (const event of session.history(0, session.boundary.sequence))
        if (event.origin.type === "publisher")
          through = event.origin.event.producerSeq;
      // Wait for the durable acknowledgement too, so detaching cannot resend.
      return (
        through >= offlineEvents.length &&
        (await bindingFile()).acknowledgedSeq >= through
      );
    });
    const streamId = delivered.ready!;
    const session = await server.store.get(streamId);
    const published = [];
    for await (const event of session.history(0, session.boundary.sequence))
      if (event.origin.type === "publisher") published.push(event.origin.event);
    // Exactly once, in producer order, always with the real recording identity.
    expect(published.map((event) => event.producerSeq)).toEqual(
      published.map((_, index) => index + 1),
    );
    expect(new Set(published.map((event) => event.streamId))).toEqual(
      new Set([streamId]),
    );
    // The events captured offline are the delivered prefix, byte for byte.
    expect(
      published
        .slice(0, offlineEvents.length)
        .map(({ streamId: _, ...rest }) => rest),
    ).toEqual(offlineEvents.map(({ streamId: _, ...rest }) => rest));
    const binding = await bindingFile();
    expect(binding.streamId).toBe(streamId);
    expect(binding.acknowledgedSeq).toBeGreaterThanOrEqual(
      offlineEvents.length,
    );
  },
);
