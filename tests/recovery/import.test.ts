import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  importCodexRecording,
  inspectCodexHistory,
  captureCodexHistory,
  CodexCapture,
} from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const rows = [
  {
    type: "session_meta",
    timestamp: "2026-09-01T00:00:00.000Z",
    payload: {
      id: "native1",
      timestamp: "2026-09-01T00:00:00.000Z",
      cli_version: "0.153.4",
      base_instructions: "private instructions must not broadcast",
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-09-01T00:00:01.000Z",
    payload: { type: "task_started", turn_id: "turn1" },
  },
  {
    type: "response_item",
    timestamp: "2026-09-01T00:00:02.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Duplicate low-level text" }],
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-09-01T00:00:02.000Z",
    payload: {
      type: "item_completed",
      item: {
        type: "AgentMessage",
        id: "message1",
        content: [{ type: "Text", text: "Imported secret123 text" }],
      },
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-09-01T00:00:03.000Z",
    payload: { type: "task_complete", turn_id: "turn1" },
  },
];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-import-test-"));
  roots.push(root);
  const sourcePath = join(root, "source.jsonl");
  await writeFile(
    sourcePath,
    rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  servers.push(server);
  const options = {
    sourcePath,
    publisherRoot: join(root, "imports"),
    serverOrigin: server.url,
    ownerCredential: "b".repeat(64),
    title: "Past Codex session",
    visibility: "public" as const,
    secrets: ["secret123"],
    signal: new AbortController().signal,
  };
  return { root, server, options };
}
it("imports native history into an ended shareable recording with original timing and filtered content", async () => {
  const { server, options } = await setup();
  const result = await importCodexRecording(options);
  const session = await server.store.get(result.streamId);
  expect(session.info.lifecycle).toBe("ended");
  expect(session.info.visibility).toBe("public");
  let state = initialState();
  const serialized = [];
  for await (const event of session.history(0, session.boundary.sequence)) {
    state = apply(state, event);
    serialized.push(event);
  }
  expect([...state.messages.values()].map((x) => x.text)).toEqual([
    "Imported [REDACTED] text",
  ]);
  expect(state.timelineMs).toBe(3000);
  expect(JSON.stringify(serialized)).not.toContain("private instructions");
  expect(JSON.stringify(serialized)).not.toContain("Duplicate low-level text");
  expect(result.report.items).toBe(1);
  expect(
    (await fetch(server.url + "/api/v1/streams/" + result.streamId)).status,
  ).toBe(200);
});
it("retries a completed import without adding another recording or duplicate events", async () => {
  const { server, options } = await setup();
  const first = await importCodexRecording(options);
  const before = (await server.store.get(first.streamId)).boundary.sequence;
  const second = await importCodexRecording(options);
  expect(second.streamId).toBe(first.streamId);
  expect((await server.store.get(first.streamId)).boundary.sequence).toBe(
    before,
  );
  await appendFile(
    options.sourcePath,
    JSON.stringify({ ...rows[4], timestamp: "2026-09-01T00:00:04.000Z" }) +
      "\n",
  );
  await expect(importCodexRecording(options)).rejects.toThrow(
    "source or options changed",
  );
});
it("uses the same item identities for historical capture and overlapping live snapshots", async () => {
  const { root, options } = await setup();
  const manifest = await inspectCodexHistory(options.sourcePath);
  const journal = await PublisherJournal.open(join(root, "overlap"), {
    serverOrigin: options.serverOrigin,
    agent: "codex",
    nativeSessionId: "native1",
  });
  try {
    await journal.bindRemote("stream1", "revision1");
    const capture = new CodexCapture(journal, [], manifest.createdAt);
    await captureCodexHistory(options.sourcePath, manifest, capture);
    const before = journal.capturedThrough;
    const live = new CodexCapture(journal);
    await live.accept({
      method: "item/completed",
      params: {
        threadId: "native1",
        item: {
          type: "agentMessage",
          id: "message1",
          text: "Imported secret123 text",
        },
      },
    });
    expect(journal.capturedThrough).toBe(before);
  } finally {
    await journal.close();
  }
});
it("requires owner authorization and an ended recording before sharing private imports", async () => {
  const { server } = await setup();
  const session = await server.store.create({
    ownerId: "local",
    requestId: "private1",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "epoch",
    writeSecret: "a".repeat(64),
    title: "staged",
    visibility: "private",
  });
  const url = server.url + "/api/v1/streams/" + session.info.id + "/share";
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"visibility":"public"}',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"b".repeat(64)}`,
          "content-type": "application/json",
        },
        body: '{"visibility":"public"}',
      })
    ).status,
  ).toBe(409);
  expect(session.info.visibility).toBe("private");
});
it("preserves a large Unicode message through bounded replacement events and replay", async () => {
  const { server, options } = await setup();
  const text = "A海🦦\n".repeat(90000);
  const source = structuredClone(rows);
  source[3]!.payload = {
    type: "item_completed",
    item: {
      type: "AgentMessage",
      id: "large1",
      content: [{ type: "Text", text }],
    },
  } as (typeof source)[3]["payload"];
  await writeFile(
    options.sourcePath,
    source.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const imported = await importCodexRecording(options);
  const session = await server.store.get(imported.streamId);
  let state = initialState();
  let replacements = 0;
  for await (const event of session.history(0, session.boundary.sequence)) {
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
    state = apply(state, event);
    if (event.content.kind === "text.replacement.completed") replacements++;
  }
  expect([...state.messages.values()][0]!.text).toBe(text);
  expect(state.replacements.size).toBe(0);
  expect(replacements).toBe(1);
});
it("retains related native thread metadata within one logical session", async () => {
  const { server, options } = await setup();
  const child = {
    type: "session_meta",
    timestamp: "2026-09-01T00:00:00.000Z",
    payload: {
      id: "child1",
      session_id: "native1",
      parent_thread_id: "native1",
      agent_path: "worker",
      timestamp: "2026-09-01T00:00:00.000Z",
      cli_version: "0.153.4",
    },
  };
  const root = {
    ...rows[0],
    payload: { ...rows[0]!.payload, session_id: "native1" },
  };
  const childMessage = {
    type: "event_msg",
    timestamp: "2026-09-01T00:00:01.000Z",
    payload: {
      type: "item_completed",
      thread_id: "child1",
      item: {
        type: "AgentMessage",
        id: "child_message",
        content: [{ type: "Text", text: "Child result" }],
      },
    },
  };
  await writeFile(
    options.sourcePath,
    [child, root, childMessage, ...rows.slice(1)]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const manifest = await inspectCodexHistory(options.sourcePath);
  expect(manifest.nativeSessionId).toBe("native1");
  expect(manifest.nativeThreadIds).toEqual(["child1", "native1"]);
  const imported = await importCodexRecording(options);
  const session = await server.store.get(imported.streamId);
  let state = initialState();
  for await (const event of session.history(0, session.boundary.sequence))
    state = apply(state, event);
  expect(state.agents.size).toBe(2);
  const message = [...state.messages.values()].find(
    (x) => x.text === "Child result",
  )!;
  expect(state.agents.get(message.agentId!)?.nativeSessionId).toBe("child1");
});
it("imports retained legacy user messages from aborted turns without completed-item records", async () => {
  const { server, options } = await setup();
  const legacy = [
    rows[0],
    rows[1],
    {
      type: "response_item",
      timestamp: "2026-09-01T00:00:02.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Retained interrupted request" }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-09-01T00:00:03.000Z",
      payload: { type: "turn_aborted" },
    },
  ];
  await writeFile(
    options.sourcePath,
    legacy.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const imported = await importCodexRecording(options);
  const session = await server.store.get(imported.streamId);
  let state = initialState();
  for await (const event of session.history(0, session.boundary.sequence))
    state = apply(state, event);
  expect([...state.messages.values()][0]!.text).toBe(
    "Retained interrupted request",
  );
});
