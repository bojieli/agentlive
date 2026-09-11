import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importClaudeRecording } from "../../packages/adapters/src/import-claude.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it("imports Claude child identities and image bytes with stable retries and scope validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-family-import-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  const row = (agent?: string) =>
    JSON.stringify({
      type: "user",
      sessionId: "session",
      uuid: "same",
      timestamp: "2026-09-01T00:00:00Z",
      ...(agent ? { agentId: agent, isSidechain: true } : {}),
      message: {
        content: [
          { type: "text", text: agent ?? "main" },
          ...(agent
            ? [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: Buffer.from([
                      137,
                      80,
                      78,
                      71,
                      13,
                      10,
                      26,
                      10,
                      agent === "worker" ? 1 : 2,
                    ]).toString("base64"),
                  },
                },
              ]
            : []),
        ],
      },
    }) + "\n";
  try {
    const sourcePath = join(root, "session.jsonl");
    const directory = join(root, "session", "subagents");
    await mkdir(directory, { recursive: true });
    await writeFile(sourcePath, row());
    for (const agent of ["worker", "other"])
      await writeFile(join(directory, `agent-${agent}.jsonl`), row(agent));
    const options = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Claude family",
      visibility: "private" as const,
      includeChildren: true,
      signal: AbortSignal.timeout(15000),
    };
    const first = await importClaudeRecording(options);
    const second = await importClaudeRecording(options);
    expect(second.streamId).toBe(first.streamId);
    expect(second.producerEvents).toBe(first.producerEvents);
    const recording = await server.store.get(first.streamId);
    try {
      let state = initialState(),
        starts = 0,
        ends = 0;
      for await (const event of recording.history(
        0,
        recording.boundary.sequence,
      )) {
        state = apply(state, event);
        if (event.content.kind === "session.started") starts++;
        if (event.content.kind === "recording.ended") ends++;
      }
      expect(starts).toBe(1);
      expect(ends).toBe(1);
      expect(
        [...state.messages.values()]
          .map((message) => message.text)
          .filter(Boolean)
          .sort(),
      ).toEqual(["main", "other", "worker"]);
      expect(state.messages.size).toBe(5);
      expect(state.references.size).toBe(2);
      const attachments = [...state.artifacts.values()].flatMap((artifact) => [
        ...artifact.versions.values(),
      ]);
      expect(attachments).toHaveLength(2);
      const received = [];
      for (const attachment of attachments) {
        const response = await fetch(
          `${server.url}/api/v1/streams/${first.streamId}/attachments/${attachment.hash}`,
          { headers: { authorization: `Bearer ${ownerCredential}` } },
        );
        expect(response.status).toBe(200);
        received.push(
          Buffer.from(await response.arrayBuffer()).toString("hex"),
        );
      }
      expect(received.sort()).toEqual([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("hex"),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]).toString("hex"),
      ]);
    } finally {
      server.store.release(recording);
    }
    await expect(
      importClaudeRecording({ ...options, includeChildren: false }),
    ).rejects.toThrow("Import source or options changed");
    await expect(
      importClaudeRecording({
        ...options,
        sourcePath: join(directory, "agent-worker.jsonl"),
      }),
    ).rejects.toThrow("requires a main transcript");
    await appendFile(join(directory, "agent-worker.jsonl"), row("worker"));
    await expect(importClaudeRecording(options)).rejects.toThrow(
      "Import source or options changed",
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects a child transcript with ownership inconsistent with its filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-family-owner-"));
  const ownerCredential = "c".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const directory = join(root, "session", "subagents");
    await mkdir(directory, { recursive: true });
    const row = {
      type: "assistant",
      sessionId: "session",
      uuid: "same",
      timestamp: "2026-09-01T00:00:00Z",
      message: { content: [{ type: "text", text: "hello" }] },
    };
    const sourcePath = join(root, "session.jsonl");
    await writeFile(sourcePath, JSON.stringify(row) + "\n");
    await writeFile(
      join(directory, "agent-worker.jsonl"),
      JSON.stringify({ ...row, agentId: "foreign", isSidechain: true }) + "\n",
    );
    await expect(
      importClaudeRecording({
        sourcePath,
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        ownerCredential,
        title: "Invalid ownership",
        visibility: "private",
        includeChildren: true,
        signal: AbortSignal.timeout(10000),
      }),
    ).rejects.toThrow("conflicting ownership");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
