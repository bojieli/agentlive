import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectClaudeHistory,
  captureClaudeHistory,
} from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
it("converts Claude text, tool failures and explicit gaps with durable retry identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-history-"));
  let journal: PublisherJournal | undefined;
  try {
    const path = join(root, "history.jsonl");
    const rows = [
      { type: "user", message: { content: "hello private-key" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            {
              type: "tool_use",
              id: "tool1",
              name: "Bash",
              input: { command: "echo private-key" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool1",
              is_error: true,
              content: "credit exhausted",
            },
          ],
        },
      },
      { type: "system", subtype: "api_error" },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "late",
              content: [
                { type: "image", source: { data: "never-broadcast-base64" } },
              ],
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "late",
              name: "Read",
              input: { path: "file.txt" },
            },
          ],
        },
      },
    ].map((row, index) => ({
      ...row,
      sessionId: "native_claude",
      uuid: `row${index}`,
      timestamp: `2026-09-01T00:00:0${index}.000Z`,
    }));
    await writeFile(
      path,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const manifest = await inspectClaudeHistory(path);
    journal = await PublisherJournal.open(join(root, "publisher"), {
      serverOrigin: "http://localhost:7331",
      agent: "claude",
      nativeSessionId: manifest.nativeSessionId,
    });
    await journal.bindRemote("stream", "revision");
    const report = await captureClaudeHistory(path, manifest, journal, [
      "private-key",
    ]);
    const before = journal.capturedThrough;
    await captureClaudeHistory(path, manifest, journal, ["private-key"]);
    expect(journal.capturedThrough).toBe(before);
    const events = [];
    for await (const event of journal.pending(0)) events.push(event.content);
    expect(JSON.stringify(events)).not.toContain("private-key");
    expect(JSON.stringify(events)).not.toContain("hidden");
    expect(
      events.some(
        (event) =>
          event.kind === "tool.completed" && event.payload.status === "failed",
      ),
    ).toBe(true);
    expect(report.unsupported).toEqual({
      "system/api_error": 1,
      "tool_result/missing_call": 1,
      "tool_result/image": 1,
    });
    expect(JSON.stringify(events)).not.toContain("never-broadcast-base64");
    expect(
      events.filter((event) => event.kind === "tool.started"),
    ).toHaveLength(2);
    expect(report.omittedReasoning).toBe(1);
  } finally {
    await journal?.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("imports a Claude recording privately, ends before sharing, and retries without duplicates", async () => {
  const { importClaudeRecording } =
    await import("../../packages/adapters/src/index.js");
  const { startServer } = await import("../../packages/server/src/http.js");
  const { initialState, apply } =
    await import("../../packages/playback/src/index.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-import-"));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  try {
    const sourcePath = join(root, "session.jsonl");
    await writeFile(
      sourcePath,
      JSON.stringify({
        type: "assistant",
        sessionId: "native_claude",
        uuid: "message1",
        timestamp: "2026-09-01T00:00:00.000Z",
        message: {
          content: [{ type: "text", text: "Historical private-key reply" }],
        },
      }) + "\n",
    );
    const options = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: "b".repeat(64),
      title: "Imported Claude",
      visibility: "private" as const,
      secrets: ["private-key"],
      signal: AbortSignal.timeout(5000),
    };
    const result = await importClaudeRecording(options);
    const session = await server.store.get(result.streamId);
    expect(session.info.lifecycle).toBe("ended");
    expect(
      (await fetch(`${server.url}/api/v1/streams/${result.streamId}`)).status,
    ).toBe(403);
    let state = initialState();
    for await (const event of session.history(0, session.boundary.sequence))
      state = apply(state, event);
    expect([...state.messages.values()].map((message) => message.text)).toEqual(
      ["Historical [REDACTED] reply"],
    );
    const before = session.boundary.sequence;
    expect((await importClaudeRecording(options)).streamId).toBe(
      result.streamId,
    );
    expect(session.boundary.sequence).toBe(before);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
