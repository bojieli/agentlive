import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importCodexRecording } from "../../packages/adapters/src/import-codex.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it("imports three Codex generations with inherited metadata and stable scoped messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-codex-family-import-"));
  const ownerCredential = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  const timestamp = "2026-09-01T00:00:00Z";
  const metadata = (id: string, parent?: string) =>
    JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: {
        id,
        session_id: "root",
        parent_thread_id: parent,
        timestamp,
        cli_version: "test",
      },
    }) + "\n";
  const message = (text: string) =>
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "item_completed",
        item: {
          id: "same",
          type: "AgentMessage",
          content: [{ type: "Text", text }],
        },
      },
    }) + "\n";
  try {
    const familyRoot = join(root, "sources");
    await mkdir(familyRoot);
    const sourcePath = join(familyRoot, "root.jsonl");
    const childPath = join(familyRoot, "child.jsonl");
    const child =
      metadata("child", "root") + metadata("root") + message("child");
    await writeFile(sourcePath, metadata("root") + message("root"));
    await writeFile(childPath, child);
    await writeFile(
      join(familyRoot, "grandchild.jsonl"),
      metadata("grandchild", "child") +
        metadata("child", "root") +
        metadata("root") +
        message("grandchild"),
    );
    await writeFile(
      join(familyRoot, "empty.jsonl"),
      metadata("empty", "root") + metadata("root"),
    );
    const options = {
      sourcePath,
      familyRoot,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Codex family",
      visibility: "private" as const,
      signal: AbortSignal.timeout(15000),
    };
    const first = await importCodexRecording(options);
    const second = await importCodexRecording(options);
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
        [...state.messages.values()].map((message) => message.text).sort(),
      ).toEqual(["child", "grandchild", "root"]);
      expect(
        new Set([...state.messages.values()].map((message) => message.agentId))
          .size,
      ).toBe(3);
    } finally {
      server.store.release(recording);
    }
    const { familyRoot: _family, ...single } = options;
    await expect(importCodexRecording(single)).rejects.toThrow(
      "Import source or options changed",
    );
    await appendFile(childPath, message("later"));
    await expect(importCodexRecording(options)).rejects.toThrow(
      "Import source or options changed",
    );
    await writeFile(childPath, metadata("child", "missing") + message("child"));
    await expect(importCodexRecording(options)).rejects.toThrow(
      "missing, cyclic",
    );
    await writeFile(childPath, child + metadata("unrelated"));
    await expect(importCodexRecording(options)).rejects.toThrow(
      "unrelated thread metadata",
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
