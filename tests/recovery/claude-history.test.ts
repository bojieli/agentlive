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
it("imports inline Claude images as downloadable historical attachments and rejects invalid base64", async () => {
  const { importClaudeRecording } =
    await import("../../packages/adapters/src/index.js");
  const { startServer } = await import("../../packages/server/src/http.js");
  const { initialState, apply } =
    await import("../../packages/playback/src/index.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-inline-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const sourcePath = join(root, "session.jsonl");
    await writeFile(
      sourcePath,
      JSON.stringify({
        type: "user",
        sessionId: "inline_claude",
        uuid: "message1",
        timestamp: "2026-09-01T00:00:00.000Z",
        message: {
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: bytes.toString("base64"),
              },
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "invalid%%%",
              },
            },
          ],
        },
      }) + "\n",
    );
    const options = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Inline images",
      visibility: "private" as const,
      signal: AbortSignal.timeout(5000),
    };
    const result = await importClaudeRecording(options);
    expect(result.report.availableAttachments).toBe(1);
    expect(result.report.unavailableAttachments).toBe(1);
    const session = await server.store.get(result.streamId);
    let state = initialState();
    for await (const event of session.history(0, session.boundary.sequence))
      state = apply(state, event);
    expect(state.references.size).toBe(1);
    const attachment = [...state.artifacts.values()].flatMap((artifact) => [
      ...artifact.versions.values(),
    ])[0]!;
    expect(attachment.provenance).toBe("historical-version");
    const response = await fetch(
      `${server.url}/api/v1/streams/${result.streamId}/attachments/${attachment.hash}`,
      { headers: { authorization: `Bearer ${ownerCredential}` } },
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const before = session.boundary.sequence;
    await importClaudeRecording(options);
    expect(session.boundary.sequence).toBe(before);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes Claude retained tool state and follows a partial result across restart", async () => {
  const { publishClaudeRecording } =
    await import("../../packages/adapters/src/index.js");
  const { startServer } = await import("../../packages/server/src/http.js");
  const { initialState, apply } =
    await import("../../packages/playback/src/index.js");
  const { appendFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-follow-"));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  const sourcePath = join(root, "native.jsonl");
  const row = (uuid: string, type: string, content: unknown) =>
    JSON.stringify({
      uuid,
      type,
      sessionId: "claude_live",
      timestamp: "2026-09-09T00:00:00Z",
      message: { content },
    });
  await writeFile(
    sourcePath,
    row("start", "assistant", [
      {
        type: "tool_use",
        id: "tool1",
        name: "Bash",
        input: { command: "echo safe" },
      },
    ]) + "\n",
  );
  let streamId = "";
  const settings = {
    sourcePath,
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential: "b".repeat(64),
    title: "Claude live test",
    visibility: "private" as const,
  };
  const attach = async (
    expectedStatus: string,
    append?: () => Promise<void>,
  ) => {
    const controller = new AbortController();
    let failure: unknown;
    let captured = 0;
    const running = publishClaudeRecording({
      ...settings,
      signal: controller.signal,
      onReady: (recording) => {
        if (streamId) expect(recording.streamId).toBe(streamId);
        streamId = recording.streamId;
      },
      onCaughtUp: async (boundary) => {
        captured = boundary.producerEvents;
        await append?.();
      },
    }).catch((error) => {
      failure = error;
    });
    try {
      await expect
        .poll(
          async () => {
            if (failure) throw failure;
            if (!streamId || !captured) return false;
            const session = await server.store.get(streamId);
            let state = initialState();
            let through = 0;
            for await (const event of session.history(
              0,
              session.boundary.sequence,
            )) {
              state = apply(state, event);
              if (event.origin.type === "publisher")
                through = event.origin.event.producerSeq;
            }
            return (
              through >= captured &&
              state.tools.size === 1 &&
              [...state.tools.values()][0]?.status === expectedStatus
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
    } finally {
      controller.abort();
      await running;
    }
    if (failure) throw failure;
  };
  try {
    await attach("running");
    const result = row("result", "user", [
      {
        type: "tool_result",
        tool_use_id: "tool1",
        is_error: true,
        content: "Subscription credits exhausted",
      },
    ]);
    await appendFile(sourcePath, result.slice(0, 40));
    await attach("failed", async () => {
      await appendFile(sourcePath, result.slice(40) + "\n");
    });
    const before = (await server.store.get(streamId)).boundary.sequence;
    await attach("failed");
    expect((await server.store.get(streamId)).boundary.sequence).toBe(before);
    await appendFile(
      sourcePath,
      JSON.stringify({
        sessionId: "other_session",
        type: "user",
        message: { content: "must not publish" },
      }) + "\n",
    );
    await expect(
      publishClaudeRecording({
        ...settings,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("multiple session identities");
    expect((await server.store.get(streamId)).boundary.sequence).toBe(before);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("imports retained file excerpts, edit snippets and plans without reading current files", async () => {
  const { importClaudeRecording } =
    await import("../../packages/adapters/src/index.js");
  const { startServer } = await import("../../packages/server/src/http.js");
  const { initialState, apply, renderTerminalSnapshot } =
    await import("../../packages/playback/src/index.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-files-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const sourcePath = join(root, "session.jsonl");
    const attachments = [
      {
        type: "file",
        filename: "/missing/private-key/source.ts",
        content: {
          type: "text",
          file: {
            filePath: "/missing/private-key/source.ts",
            content: "captured private-key code",
            startLine: 10,
            numLines: 2,
            totalLines: 100,
          },
        },
      },
      {
        type: "edited_text_file",
        filename: "/missing/source.ts",
        snippet: "edited private-key snippet",
      },
      {
        type: "plan_file_reference",
        planFilePath: "/missing/plan.md",
        planContent: "# Plan\nprivate-key content",
      },
      {
        type: "file",
        filename: "/missing/unsupported",
        content: { type: "binary" },
      },
    ];
    await writeFile(
      sourcePath,
      attachments
        .map((attachment, index) =>
          JSON.stringify({
            type: "attachment",
            uuid: "a" + index,
            sessionId: "files_claude",
            timestamp: "2026-09-01T00:00:00.000Z",
            attachment,
          }),
        )
        .join("\n") + "\n",
    );
    const options = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Files",
      visibility: "private" as const,
      secrets: ["private-key"],
      signal: AbortSignal.timeout(10000),
    };
    const imported = await importClaudeRecording(options);
    expect(imported.report.availableAttachments).toBe(3);
    expect(imported.report.unsupported).toEqual({ attachment: 1 });
    const session = await server.store.get(imported.streamId);
    let state = initialState();
    for await (const event of session.history(0, session.boundary.sequence))
      state = apply(state, event);
    expect(state.references.size).toBe(3);
    expect(state.plans.size).toBe(1);
    expect([...state.plans.values()][0]).toMatchObject({
      status: "unknown",
      sourceReference: "/missing/plan.md",
    });
    expect([...state.plans.values()][0]?.attachment).toBeDefined();
    const downloads: string[] = [];
    for (const artifact of state.artifacts.values()) {
      const attachment = [...artifact.versions.values()][0]!;
      expect(attachment.provenance).toBe("historical-version");
      const url =
        server.url +
        "/api/v1/streams/" +
        imported.streamId +
        "/attachments/" +
        attachment.hash;
      expect((await fetch(url)).status).toBe(403);
      const response = await fetch(url, {
        headers: { authorization: "Bearer " + ownerCredential },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("private-key");
      downloads.push(text);
    }
    expect(downloads.join("\n")).toContain(
      "Start line: 10; captured lines: 2; source total lines: 100",
    );
    expect(downloads.join("\n")).toContain("edited [REDACTED] snippet");
    expect(downloads).toContain("# Plan\n[REDACTED] content");
    const rendered = [
      ...renderTerminalSnapshot(state, server.url, imported.streamId),
    ].join("");
    expect(rendered).toContain("Recorded file excerpt");
    expect(rendered).toContain("Recorded edit snippet");
    expect(rendered).toContain("Recorded plan");
    expect(rendered).not.toContain("private-key");
    const before = session.boundary.sequence;
    await importClaudeRecording(options);
    expect(session.boundary.sequence).toBe(before);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
