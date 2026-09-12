import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import type { PublishedEvent } from "../../packages/protocol/src/index.js";

const owner = "a".repeat(64);
const writeSecret = "b".repeat(64);

const event = (
  streamId: string,
  producerSeq: number,
  content: PublishedEvent["content"],
): PublishedEvent => ({
  protocolVersion: 1,
  streamId,
  producerEpoch: "e",
  producerSeq,
  observedAt: new Date().toISOString(),
  clockSegmentId: "clock",
  elapsedMs: producerSeq,
  fidelity: "delta",
  source: { agent: "synthetic", sessionId: "blocked" },
  content,
});

it("reports the recording an unreducible event stopped, instead of retrying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-snapshot-blocked-"));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: owner,
    port: 0,
    metrics: { token: "metrics-token-" + "m".repeat(32) },
    snapshots: { pollMs: 10, intervalMs: 20, batchEvents: 2, timeoutMs: 5000 },
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "blocked",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret,
      visibility: "private",
      title: "Blocked fixture",
    });
    const streamId = session.info.id;
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 1,
      revision: session.info.revision,
    });
    // The server accepts these: each is a valid protocol event on its own. Only the
    // reducer can see that the third appends to a message that never started.
    await session.append(lease, [
      event(streamId, 1, {
        kind: "message.started",
        payload: { messageId: "m1", role: "assistant" },
      }),
      event(streamId, 2, {
        kind: "message.text.append",
        payload: { messageId: "m1", text: "hello" },
      }),
      event(streamId, 3, {
        kind: "message.text.append",
        payload: { messageId: "absent", text: "orphan" },
      }),
    ]);
    const state = async () =>
      (await (
        await fetch(
          `${server.url}/api/v1/streams/${streamId}/publisher-state`,
          { headers: { authorization: `Bearer ${writeSecret}` } },
        )
      ).json()) as { snapshotBlocked?: { serverSeq: number; code: string } };
    await expect
      .poll(async () => (await state()).snapshotBlocked, { timeout: 15000 })
      .toEqual({
        serverSeq: 4,
        code: "sequence_gap",
        reason: expect.stringContaining("Missing lifecycle start"),
      });
    const metrics = await (
      await fetch(`${server.url}/metrics`, {
        headers: {
          authorization: `Bearer ${"metrics-token-" + "m".repeat(32)}`,
        },
      })
    ).text();
    expect(metrics).toContain("agentlive_snapshot_blocked_recordings 1");
    // Neither the sequence number nor the metric carries recording content.
    expect(metrics).not.toContain(streamId);
    expect(metrics).not.toContain("orphan");
    // Live delivery and raw history are unaffected by the stalled builder.
    const history = await (
      await fetch(
        `${server.url}/api/v1/streams/${streamId}/events?revision=${session.info.revision}&afterServerSeq=0&throughServerSeq=${session.info.serverSeq}`,
        { headers: { authorization: `Bearer ${writeSecret}` } },
      )
    ).text();
    expect(history).toContain("orphan");
    // And the failure does not repeat: the counter stays where it stopped.
    const failures = server.store.snapshotStatus.failures;
    await new Promise((done) => setTimeout(done, 300));
    expect(server.store.snapshotStatus.failures).toBe(failures);
    expect(server.store.snapshotStatus.blocked).toBe(1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
