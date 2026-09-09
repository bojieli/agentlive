import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PublisherJournal,
  PublisherNetwork,
  type CaptureInput,
} from "../../packages/publisher/src/index.js";
import { SubscriberClient } from "../../packages/client/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const journals: PublisherJournal[] = [];
const runs: { abort: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const run of runs) run.abort.abort();
  await Promise.all(runs.splice(0).map((x) => x.done.catch(() => {})));
  for (const journal of journals.splice(0)) await journal.close();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-network-test-"));
  roots.push(root);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  servers.push(server);
  const identity = {
    serverOrigin: server.url,
    agent: "synthetic" as const,
    nativeSessionId: "native_1",
  };
  const journal = await PublisherJournal.open(
    join(root, "publisher"),
    identity,
  );
  journals.push(journal);
  return { root, server, journal, identity };
}
function network(
  journal: PublisherJournal,
  extra: Partial<ConstructorParameters<typeof PublisherNetwork>[0]> = {},
) {
  return new PublisherNetwork({
    journal,
    ownerCredential: "b".repeat(64),
    title: "Network integration",
    visibility: "public",
    retryMinMs: 5,
    retryMaxMs: 10,
    ...extra,
  });
}
function capture(n: number): CaptureInput {
  return {
    sourceKey: `source_${n}`,
    observedAt: new Date().toISOString(),
    clockSegmentId: "clock1",
    elapsedMs: n,
    fidelity: "delta",
    adapterState: { n },
    content: [
      {
        kind: "message.started",
        payload: { messageId: `m${n}`, role: "assistant" },
      },
    ],
  };
}
function run(client: { run: (signal: AbortSignal) => Promise<void> }) {
  const abort = new AbortController(),
    done = client.run(abort.signal);
  void done.catch(() => {});
  runs.push({ abort, done });
  return { abort, done };
}
it("creates one recording after a lost create response and binds before publishing", async () => {
  const { server, journal } = await setup();
  let dropped = false;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!dropped) {
      dropped = true;
      await response.text();
      throw new TypeError("simulated response loss");
    }
    return response;
  };
  const client = network(journal, { fetch: fetcher });
  await expect(
    client.ensureRemote(new AbortController().signal),
  ).rejects.toThrow("response loss");
  expect(journal.identity.streamId).toBeNull();
  await client.ensureRemote(new AbortController().signal);
  const first = journal.identity.streamId;
  await client.ensureRemote(new AbortController().signal);
  expect(journal.identity.streamId).toBe(first);
  expect((await server.store.get(first!)).boundary.sequence).toBe(1);
});
it("publishes captured events through the real server into shared subscriber state", async () => {
  const { journal, server } = await setup();
  const client = network(journal);
  await client.ensureRemote(new AbortController().signal);
  await journal.capture(capture(1));
  await journal.capture(capture(2));
  const publisher = run(client);
  const seen: number[] = [];
  const subscriber = new SubscriberClient({
    serverOrigin: server.url,
    cursor: {
      streamId: journal.identity.streamId!,
      revision: journal.identity.revision!,
      serverSeq: 0,
    },
    commit: async (events) => {
      seen.push(...events.map((x) => x.serverSeq));
    },
  });
  const watcher = run(subscriber);
  await expect.poll(() => seen.at(-1)).toBe(3);
  await expect.poll(() => journal.identity.acknowledgedSeq).toBe(2);
  await journal.capture(capture(3));
  await expect.poll(() => seen.at(-1)).toBe(4);
  await expect.poll(() => journal.identity.acknowledgedSeq).toBe(3);
  publisher.abort.abort();
  watcher.abort.abort();
  await Promise.all([publisher.done, watcher.done]);
  expect(seen).toEqual([1, 2, 3, 4]);
});
it("reconciles a durable server prefix whose ACK was lost before the publisher restarted", async () => {
  const { journal, server, root, identity } = await setup();
  await network(journal).ensureRemote(new AbortController().signal);
  const events = await journal.capture(capture(1));
  const session = await server.store.get(journal.identity.streamId!);
  const attempt = await journal.nextConnectionAttempt();
  const resumed = await session.resume(journal.identity.writeSecret, {
    publisherId: journal.identity.publisherId,
    producerEpoch: journal.identity.producerEpoch,
    revision: journal.identity.revision!,
    attempt,
  });
  await session.append(resumed.lease, events);
  expect(journal.identity.acknowledgedSeq).toBe(0);
  const binding = journal.identity;
  await journal.close();
  journals.splice(journals.indexOf(journal), 1);
  const restored = await PublisherJournal.open(
    join(root, "publisher"),
    identity,
  );
  journals.push(restored);
  const publishing = run(network(restored));
  await expect.poll(() => restored.identity.acknowledgedSeq).toBe(1);
  expect(restored.identity.streamId).toBe(binding.streamId);
  expect(session.boundary.sequence).toBe(2);
  publishing.abort.abort();
  await publishing.done;
});
it("preserves paused sharing across restart and publishes backlog only after explicit resume", async () => {
  const { journal, root, identity, server } = await setup();
  await network(journal).ensureRemote(new AbortController().signal);
  await journal.capture(capture(1));
  await journal.setSharing(false);
  await journal.close();
  journals.splice(journals.indexOf(journal), 1);
  const restored = await PublisherJournal.open(
    join(root, "publisher"),
    identity,
  );
  journals.push(restored);
  let paused = false;
  const active = run(
    network(restored, {
      onStatus: (status) => {
        if (status === "paused") paused = true;
      },
    }),
  );
  await expect.poll(() => paused).toBe(true);
  expect(restored.identity.connectionAttempt).toBe(0);
  expect(
    (await server.store.get(restored.identity.streamId!)).boundary.sequence,
  ).toBe(1);
  await restored.setSharing(true);
  await expect.poll(() => restored.identity.acknowledgedSeq).toBe(1);
  active.abort.abort();
  await active.done;
});
it("automatically reconnects after server downtime and sends events captured while offline", async () => {
  const { journal, server, root } = await setup();
  const client = network(journal);
  await client.ensureRemote(new AbortController().signal);
  await journal.capture(capture(1));
  const active = run(client);
  await expect.poll(() => journal.identity.acknowledgedSeq).toBe(1);
  const identity = journal.identity;
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  await journal.capture(capture(2));
  await journal.capture(capture(3));
  const restarted = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: Number(new URL(server.url).port),
  });
  servers.push(restarted);
  await expect.poll(() => journal.identity.acknowledgedSeq).toBe(3);
  expect(journal.identity.streamId).toBe(identity.streamId);
  expect(journal.identity.revision).toBe(identity.revision);
  expect(journal.identity.connectionAttempt).toBeGreaterThan(
    identity.connectionAttempt,
  );
  expect(
    (await restarted.store.get(identity.streamId!)).boundary.sequence,
  ).toBe(4);
  active.abort.abort();
  await active.done;
});
