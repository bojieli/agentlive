import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PublisherJournal,
  StreamingRedactor,
  type CaptureInput,
} from "../../packages/publisher/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const identity = {
  serverOrigin: "https://example.test",
  agent: "synthetic" as const,
  nativeSessionId: "native_1",
};
const capture: CaptureInput = {
  sourceKey: "source_1",
  observedAt: "2026-09-09T00:00:00Z",
  clockSegmentId: "clock_1",
  elapsedMs: 10,
  fidelity: "delta",
  adapterState: { sourceCursor: 1, message: "m1" },
  content: [
    {
      kind: "message.started",
      payload: { messageId: "m1", role: "assistant" },
    },
    {
      kind: "message.text.append",
      payload: { messageId: "m1", text: "hello" },
    },
  ],
};
async function root() {
  const path = await mkdtemp(join(tmpdir(), "agentlive-publisher-test-"));
  roots.push(path);
  return path;
}
it("restores native binding, secret, checkpoint and pending events after a publisher restart", async () => {
  const path = await root();
  let journal = await PublisherJournal.open(path, identity);
  const secret = journal.identity.writeSecret;
  await journal.bindRemote("stream_1", "revision_1");
  await journal.capture(capture);
  await journal.acknowledge(1);
  await journal.nextConnectionAttempt();
  await journal.close();
  journal = await PublisherJournal.open(path, identity);
  expect(journal.identity.writeSecret).toBe(secret);
  expect(journal.identity.streamId).toBe("stream_1");
  expect(journal.checkpoint).toEqual(capture.adapterState);
  expect(journal.capturedThrough).toBe(2);
  const events = [];
  for await (const event of journal.pending()) events.push(event);
  expect(events.map((x) => x.producerSeq)).toEqual([2]);
  expect(await journal.nextConnectionAttempt()).toBe(2);
  await journal.close();
});
it("deduplicates replayed source effects after restart and rejects conflicting replay", async () => {
  const path = await root();
  let journal = await PublisherJournal.open(path, identity);
  await journal.bindRemote("s", "r");
  const events = await journal.capture(capture);
  await journal.close();
  journal = await PublisherJournal.open(path, identity);
  expect(
    await journal.capture({ ...capture, observedAt: "2026-09-10T00:00:00Z" }),
  ).toEqual(events);
  expect(journal.capturedThrough).toBe(2);
  await expect(
    journal.capture({ ...capture, content: [] }),
  ).rejects.toMatchObject({ code: "event_conflict" });
  await journal.close();
});
it("preserves intentional pause across restart and refuses ACKs beyond the captured prefix", async () => {
  const path = await root();
  let journal = await PublisherJournal.open(path, identity);
  await journal.bindRemote("s", "r");
  await journal.setSharing(false);
  await journal.close();
  journal = await PublisherJournal.open(path, identity);
  await expect(journal.capture(capture)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(journal.acknowledge(1)).rejects.toMatchObject({
    code: "sequence_gap",
  });
  await journal.close();
});
it("reports spool exhaustion before advancing the source checkpoint", async () => {
  const journal = await PublisherJournal.open(await root(), identity, 100);
  await journal.bindRemote("s", "r");
  await expect(journal.capture(capture)).rejects.toMatchObject({
    code: "storage_failed",
  });
  expect(journal.capturedThrough).toBe(0);
  expect(journal.checkpoint).toBeNull();
  await journal.close();
});
it("redacts known credentials split at every byte boundary without losing Unicode text", () => {
  const secret = "synthetic-secret-123";
  const input = `雨 ${secret} 🌧️`;
  for (let split = 0; split <= input.length; split++) {
    const redactor = new StreamingRedactor([secret]);
    const output =
      redactor.push(input.slice(0, split)) +
      redactor.push(input.slice(split)) +
      redactor.finish();
    expect(output).toBe("雨 [REDACTED] 🌧️");
  }
  const overlap = new StreamingRedactor(["abcd", "abcdef"]);
  expect(overlap.push("abcd")).toBe("");
  expect(overlap.push("ef!") + overlap.finish()).toBe("[REDACTED]!");
});

it("prevents concurrent processes from replacing the same native-session binding", async () => {
  const path = await root();
  const first = await PublisherJournal.open(path, identity);
  try {
    await expect(PublisherJournal.open(path, identity)).rejects.toMatchObject({
      code: "publisher_busy",
    });
  } finally {
    await first.close();
  }
  const reopened = await PublisherJournal.open(path, identity);
  await reopened.close();
});
