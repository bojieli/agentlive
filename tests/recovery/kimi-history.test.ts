import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKimiRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it("imports Kimi wire text and failed tools with agent identity, filtering and stable retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-test-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const sourcePath = join(root, "wire.jsonl"),
      time = Date.parse("2026-09-01T00:00:00.000Z");
    const rows = [
      { type: "metadata", protocol_version: "1.5", created_at: time },
      {
        type: "context.append_message",
        time,
        message: {
          role: "user",
          content: [{ type: "text", text: "Question" }],
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 1,
        event: {
          type: "content.part",
          uuid: "text1",
          part: { type: "text", text: "Reply private-key" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 2,
        event: {
          type: "content.part",
          uuid: "think1",
          part: { type: "think", think: "unpublished reasoning" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 3,
        event: {
          type: "tool.call",
          uuid: "call1",
          toolCallId: "tool1",
          name: "Shell",
          args: { command: "echo private-key" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 4,
        event: {
          type: "tool.result",
          parentUuid: "call1",
          toolCallId: "tool1",
          result: {
            output: [
              { type: "text", text: "failed" },
              {
                type: "image_url",
                imageUrl: { url: "private-image-reference" },
              },
            ],
            isError: true,
            truncated: true,
          },
        },
      },
    ];
    await writeFile(
      sourcePath,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const options = {
      sourcePath,
      nativeIdentity: { nativeSessionId: "kimi_session", agentId: "main" },
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Kimi import",
      visibility: "private" as const,
      secrets: ["private-key"],
      signal: AbortSignal.timeout(5000),
    };
    const result = await importKimiRecording(options);
    const session = await server.store.get(result.streamId);
    let state = initialState();
    const events = [];
    for await (const event of session.history(0, session.boundary.sequence)) {
      state = apply(state, event);
      events.push(event);
    }
    expect([...state.messages.values()].map((message) => message.text)).toEqual(
      ["Question", "Reply [REDACTED]"],
    );
    expect(state.agents.size).toBe(1);
    expect([...state.tools.values()][0]!.status).toBe("failed");
    expect(JSON.stringify(events)).not.toContain("private-key");
    expect(JSON.stringify(events)).not.toContain("unpublished reasoning");
    expect(result.report.unsupported).toEqual({
      "tool_result/source_truncated": 1,
      "tool_result/image_url": 1,
    });
    const before = session.boundary.sequence;
    await importKimiRecording(options);
    expect(session.boundary.sequence).toBe(before);
    expect(
      (await fetch(`${server.url}/api/v1/streams/${result.streamId}`)).status,
    ).toBe(403);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
