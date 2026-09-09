import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importOpenCodeRecording,
  inspectOpenCodeHistory,
} from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it("imports OpenCode message/tool/error exports with filtered replay and deterministic retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-test-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const time = Date.parse("2026-09-01T00:00:00.000Z"),
      sourcePath = join(root, "export.json");
    const source = {
      info: { id: "ses_test", time: { created: time } },
      messages: [
        {
          info: {
            id: "msg_test",
            sessionID: "ses_test",
            role: "assistant",
            time: { created: time },
            error: {
              name: "APIError",
              data: {
                message: "credits private-key exhausted",
                headers: { secret: "never-forward-headers" },
              },
            },
          },
          parts: [
            {
              id: "prt_text",
              sessionID: "ses_test",
              messageID: "msg_test",
              type: "text",
              text: "Starting private-key",
            },
            {
              id: "prt_tool",
              sessionID: "ses_test",
              messageID: "msg_test",
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                input: { command: "echo private-key" },
                error: "command failed",
                time: { start: time + 1, end: time + 2 },
              },
            },
            {
              id: "prt_file",
              sessionID: "ses_test",
              messageID: "msg_test",
              type: "file",
              url: "file:///private/source.png",
            },
          ],
        },
      ],
    };
    await writeFile(sourcePath, JSON.stringify(source));
    const options = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "OpenCode import",
      visibility: "private" as const,
      secrets: ["private-key"],
      signal: AbortSignal.timeout(5000),
    };
    const result = await importOpenCodeRecording(options),
      session = await server.store.get(result.streamId);
    let state = initialState();
    const events = [];
    for await (const event of session.history(0, session.boundary.sequence)) {
      state = apply(state, event);
      events.push(event);
    }
    expect([...state.messages.values()][0]!.text).toBe(
      "Starting [REDACTED]\ncredits [REDACTED] exhausted",
    );
    expect([...state.tools.values()][0]!.status).toBe("failed");
    expect(JSON.stringify(events)).not.toContain("never-forward-headers");
    expect(JSON.stringify(events)).not.toContain("private-key");
    expect(result.report.unavailableAttachments).toBe(1);
    const before = session.boundary.sequence;
    await importOpenCodeRecording(options);
    expect(session.boundary.sequence).toBe(before);
    expect(session.info.lifecycle).toBe("ended");
    expect(
      (await fetch(`${server.url}/api/v1/streams/${result.streamId}`)).status,
    ).toBe(403);
    source.messages[0]!.parts[0]!.sessionID = "wrong_session";
    await writeFile(sourcePath, JSON.stringify(source));
    await expect(inspectOpenCodeHistory(sourcePath)).rejects.toThrow(
      /conflicting part/,
    );
    await truncate(sourcePath, 64 * 1024 * 1024 + 1);
    await expect(inspectOpenCodeHistory(sourcePath)).rejects.toThrow(/64 MiB/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
