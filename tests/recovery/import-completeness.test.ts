import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importClaudeRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import {
  apply,
  initialState,
  type RecordingState,
} from "../../packages/playback/src/index.js";
import { openArchive } from "../../packages/storage/src/archive.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const owner = "d".repeat(64);
const row = (uuid: string, type: string, content: unknown[]) =>
  JSON.stringify({
    type,
    sessionId: "session",
    uuid,
    timestamp: "2026-09-01T00:00:0" + uuid.slice(-1) + "Z",
    message: { role: type, content },
  }) + "\n";
const unfinished =
  row("u1", "user", [{ type: "text", text: "run the tests" }]) +
  row("a2", "assistant", [
    { type: "text", text: "Running now" },
    { type: "tool_use", id: "call", name: "Bash", input: { command: "test" } },
  ]);
const finished =
  unfinished +
  row("u3", "user", [
    { type: "tool_result", tool_use_id: "call", content: "passed" },
  ]);
async function setup(transcript: string) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-import-notice-"));
  roots.push(root);
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, transcript);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: owner,
    port: 0,
  });
  servers.push(server);
  return {
    root,
    server,
    options: {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: owner,
      title: "Frozen Claude session",
      visibility: "private" as const,
      signal: AbortSignal.timeout(15000),
    },
  };
}
async function history(
  server: Awaited<ReturnType<typeof startServer>>,
  streamId: string,
) {
  const recording = await server.store.get(streamId);
  try {
    const events: StoredEvent[] = [];
    let state: RecordingState = initialState();
    for await (const event of recording.history(
      0,
      recording.boundary.sequence,
    )) {
      events.push(event);
      state = apply(state, event);
    }
    return { events, state };
  } finally {
    server.store.release(recording);
  }
}
it("persists a frozen-boundary notice for an unfinished file-agent tool, idempotently and through archives", async () => {
  const { root, server, options } = await setup(unfinished);
  const first = await importClaudeRecording(options);
  const before = await history(server, first.streamId);
  const notices = before.events.filter(
    (event) => event.content.kind === "capture.completeness",
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]!.content.payload).toEqual({
    version: 1,
    reason: "frozen-native-source",
    unfinishedMessages: 0,
    unfinishedTools: 1,
    withheldTextMessages: 0,
  });
  // The notice is the last imported event, before the server ends the recording.
  expect(before.events.at(-1)!.content.kind).toBe("recording.ended");
  expect(before.events.at(-2)).toBe(notices[0]);
  expect(before.events.at(-2)!.timelineMs).toBe(
    before.events.at(-3)!.timelineMs,
  );
  expect(before.state.completeness).toMatchObject({
    unfinishedTools: 1,
    at: notices[0]!.serverSeq,
  });
  const directory = join(
    options.publisherRoot,
    (await readdir(options.publisherRoot))[0]!,
  );
  expect(
    JSON.parse(await readFile(join(directory, "import.json"), "utf8"))
      .completenessNotice,
  ).toBe(1);
  const retry = await importClaudeRecording(options);
  expect(retry).toEqual(first);
  expect((await history(server, first.streamId)).events).toEqual(before.events);
  const archive = join(root, "frozen.agentlive");
  await exportRecording({
    serverOrigin: server.url,
    streamId: first.streamId,
    output: archive,
    credential: owner,
    signal: options.signal,
  });
  const opened = await openArchive(archive);
  try {
    expect(opened.manifest.provenance.completenessNotice).toEqual(
      before.state.completeness,
    );
  } finally {
    await opened.close();
  }
  const restored = await importArchiveRecording({
    source: archive,
    serverOrigin: server.url,
    credential: owner,
    signal: options.signal,
  });
  expect((await history(server, restored.streamId)).state.completeness).toEqual(
    before.state.completeness,
  );
});
it("adds no notice for a finished source or a binding imported before notices existed", async () => {
  const done = await setup(finished);
  const complete = await importClaudeRecording(done.options);
  expect(
    (await history(done.server, complete.streamId)).events.some(
      (event) => event.content.kind === "capture.completeness",
    ),
  ).toBe(false);
  const legacy = await setup(unfinished);
  // Recreate the pre-notice manifest shape before any capture happens.
  let directory = "";
  await expect(
    importClaudeRecording({
      ...legacy.options,
      beforeImport: async (identity, target) => {
        const { completenessNotice: _added, ...previous } = identity as {
          completenessNotice?: number;
        };
        expect(_added).toBe(1);
        directory = target;
        await writeFile(join(target, "import.json"), JSON.stringify(previous));
        throw new Error("stop before capture");
      },
    }),
  ).rejects.toThrow("stop before capture");
  const first = await importClaudeRecording(legacy.options);
  const events = (await history(legacy.server, first.streamId)).events;
  expect(
    events.some((event) => event.content.kind === "capture.completeness"),
  ).toBe(false);
  expect(
    JSON.parse(await readFile(join(directory, "import.json"), "utf8")),
  ).not.toHaveProperty("completenessNotice");
  expect(await importClaudeRecording(legacy.options)).toEqual(first);
  expect((await history(legacy.server, first.streamId)).events).toEqual(events);
});
