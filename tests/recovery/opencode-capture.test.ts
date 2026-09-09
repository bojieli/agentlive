import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeCapture,
  parseOpenCodeSnapshot,
} from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
const roots: string[] = [];
const journals: PublisherJournal[] = [];
const captures: OpenCodeCapture[] = [];
afterEach(async () => {
  for (const capture of captures.splice(0)) await capture.close();
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-capture-"));
  roots.push(root);
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "http://localhost",
    agent: "opencode",
    nativeSessionId: "ses_test",
  });
  journals.push(journal);
  await journal.bindRemote("stream1", "revision1");
  return journal;
}
function snapshot(text: string, complete = false, toolStatus?: string) {
  return parseOpenCodeSnapshot({
    info: { id: "ses_test", time: { created: 1 } },
    messages: [
      {
        info: {
          id: "msg1",
          sessionID: "ses_test",
          role: "assistant",
          time: { created: 1, ...(complete ? { completed: 2 } : {}) },
        },
        parts: [
          {
            id: "part1",
            messageID: "msg1",
            sessionID: "ses_test",
            type: "text",
            text,
          },
          ...(toolStatus
            ? [
                {
                  id: "tool1",
                  messageID: "msg1",
                  sessionID: "ses_test",
                  type: "tool",
                  tool: "bash",
                  state: {
                    status: toolStatus,
                    input: { command: "echo token_abcdef" },
                    output: "done token_abcdef",
                  },
                },
              ]
            : []),
        ],
      },
    ],
  });
}
async function replay(journal: PublisherJournal) {
  let state = initialState();
  const events = [];
  for await (const event of journal.pending(0)) {
    events.push(event);
    state = apply(state, {
      protocolVersion: 1,
      serverSeq: event.producerSeq,
      receivedAt: event.observedAt,
      timelineMs: event.elapsedMs,
      content: event.content,
      origin: { type: "server", operationId: `test${event.producerSeq}` },
    });
  }
  return { state, events };
}
it("reconciles partial secrets, tools and repeated snapshots across restart without duplicates", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal, ["token_abcdef"]);
  captures.push(capture);
  await capture.accept(snapshot("before token_abc", false, "pending"));
  let result = await replay(journal);
  expect([...result.state.messages.values()][0]?.text).toBe("before ");
  expect([...result.state.tools.values()][0]?.input).toBe("");
  expect(JSON.stringify(result.events)).not.toContain("token_abc");
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal, ["token_abcdef"]);
  captures.push(capture);
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  result = await replay(journal);
  expect([...result.state.messages.values()][0]).toMatchObject({
    text: "before [REDACTED] after",
    completed: true,
  });
  expect([...result.state.tools.values()][0]).toMatchObject({
    status: "completed",
    output: "done [REDACTED]",
  });
  expect(JSON.stringify(result.events)).not.toContain("token_abc");
  const before = journal.capturedThrough;
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  expect(journal.capturedThrough).toBe(before);
  await capture.accept(snapshot("changed", true, "completed"));
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  expect(journal.capturedThrough).toBeGreaterThan(before);
  expect([...(await replay(journal)).state.messages.values()][0]?.text).toBe(
    "before [REDACTED] after",
  );
  expect(
    await readFile(
      join(journal.directory, "opencode-live", "state.json"),
      "utf8",
    ),
  ).not.toContain("token_abc");
});
it("finishes a staged large revision after a lost journal acknowledgment before accepting a newer snapshot", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const real = journal.capture.bind(journal);
  let calls = 0;
  const spy = vi.spyOn(journal, "capture").mockImplementation(async (input) => {
    const result = await real(input);
    if (++calls === 4) throw new Error("Lost local capture acknowledgment");
    return result;
  });
  try {
    await expect(
      capture.accept(snapshot("long text ".repeat(15000), true)),
    ).rejects.toThrow("Lost local");
  } finally {
    spy.mockRestore();
  }
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  expect((await replay(journal)).state.replacements.size).toBe(0);
  expect([...(await replay(journal)).state.messages.values()][0]?.text).toBe(
    "long text ".repeat(15000),
  );
  await capture.accept(snapshot("newer state", true));
  const result = await replay(journal);
  expect(result.state.messages.size).toBe(1);
  expect([...result.state.messages.values()][0]?.text).toBe("newer state");
  expect(
    result.events.filter((event) => event.content.kind === "message.started"),
  ).toHaveLength(1);
});
it("reports removal once and refuses changed policy or missing durable state", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("retained", true));
  const empty = parseOpenCodeSnapshot({
    info: { id: "ses_test", time: { created: 1 } },
    messages: [],
  });
  await capture.accept(empty);
  const before = journal.capturedThrough;
  await capture.accept(empty);
  expect(journal.capturedThrough).toBe(before);
  expect((await replay(journal)).state.gaps).toHaveLength(1);
  await capture.close();
  captures.pop();
  await expect(OpenCodeCapture.open(journal, ["changed-key"])).rejects.toThrow(
    "filtering policy changed",
  );
  await rm(join(journal.directory, "opencode-live", "state.json"));
  await expect(OpenCodeCapture.open(journal)).rejects.toThrow(
    "state is missing",
  );
});
it("rejects a reused message identity with a different role before capture", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("assistant", true));
  const before = journal.capturedThrough;
  const changed = snapshot("user", true);
  changed.messages[0]!.info.role = "user";
  await expect(capture.accept(changed)).rejects.toThrow(
    "object identity changed",
  );
  expect(journal.capturedThrough).toBe(before);
});
it("freezes queued native snapshots before the caller mutates their parts", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const input = snapshot("original", true, "completed");
  const pending = capture.accept(input);
  input.messages[0]!.parts[0]!.text = "changed after receipt";
  (input.messages[0]!.parts[1]!.state as { output: string }).output =
    "changed output";
  await pending;
  const result = await replay(journal);
  expect([...result.state.messages.values()][0]?.text).toBe("original");
  expect([...result.state.tools.values()][0]?.output).toBe("done token_abcdef");
});
it("stops between durable entities on cancellation and safely resumes the snapshot", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const controller = new AbortController();
  const real = journal.capture.bind(journal);
  const spy = vi.spyOn(journal, "capture").mockImplementation(async (input) => {
    const result = await real(input);
    if (input.content[0]?.kind === "message.started") controller.abort();
    return result;
  });
  try {
    await expect(
      capture.accept(
        snapshot("retained", true, "completed"),
        controller.signal,
      ),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect((await replay(journal)).state.messages.size).toBe(1);
  expect((await replay(journal)).state.tools.size).toBe(0);
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("retained", true, "completed"));
  expect((await replay(journal)).state.tools.size).toBe(1);
});
