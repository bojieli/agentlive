import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PublisherJournal,
  RedactionGuard,
  type CaptureInput,
} from "../../packages/publisher/src/index.js";

const roots: string[] = [];
const journals: PublisherJournal[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const SECRET = "publisher-secret-value-9f3a2b";

async function opened() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-redaction-guard-"));
  roots.push(root);
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.test",
    agent: "synthetic",
    nativeSessionId: "native_1",
  });
  journals.push(journal);
  return journal;
}

const input = (n: number, content: CaptureInput["content"]): CaptureInput => ({
  sourceKey: `source_${n}`,
  observedAt: "2026-09-12T00:00:00.000Z",
  clockSegmentId: "clock_1",
  elapsedMs: n,
  fidelity: "delta",
  adapterState: null,
  content,
});

it("ignores values too short or too long to be a declared secret", () => {
  const guard = new RedactionGuard(["short", SECRET, SECRET, "x".repeat(4097)]);
  expect(guard.size).toBe(1);
  // A short value is left to the adapters; it would match ordinary prose.
  expect(() =>
    guard.assertClean("short text", "A captured event"),
  ).not.toThrow();
});

it("stops a capture whose text an adapter forgot to redact", async () => {
  const journal = await opened();
  journal.enforceRedaction([SECRET]);
  await expect(
    journal.capture(
      input(1, [
        {
          kind: "message.started",
          payload: { messageId: "m1", role: "assistant" },
        },
        {
          kind: "message.text.append",
          payload: { messageId: "m1", text: `leaked ${SECRET}` },
        },
      ]),
    ),
  ).rejects.toThrow("still contains a value this publisher filters");
  // Nothing was written: the check runs before the journal is touched.
  expect(journal.capturedThrough).toBe(0);
  // The message never repeats the value it found.
  await journal
    .capture(input(1, [{ kind: "capture.gap", payload: { reason: SECRET } }]))
    .catch((error: Error) => expect(error.message).not.toContain(SECRET));
});

it("covers fields an adapter does not treat as text", async () => {
  const journal = await opened();
  journal.enforceRedaction([SECRET]);
  // An identifier, not prose: no adapter runs a text redactor over it.
  await expect(
    journal.capture(
      input(2, [
        {
          kind: "tool.started",
          payload: { toolId: `tool-${SECRET}`, name: "bash", input: "ls" },
        },
      ]),
    ),
  ).rejects.toThrow("still contains a value this publisher filters");
  expect(journal.capturedThrough).toBe(0);
  // Redacted content passes and is captured normally.
  const events = await journal.capture(
    input(3, [
      {
        kind: "tool.started",
        payload: { toolId: "tool-redacted", name: "bash", input: "ls" },
      },
    ]),
  );
  expect(events).toHaveLength(1);
  expect(journal.capturedThrough).toBe(1);
});
