import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  importClaudeRecording,
  importKimiRecording,
} from "../../packages/adapters/src/index.js";
import {
  captureCompletenessNotice,
  IMPORT_COMPLETENESS_SOURCE_KEY,
} from "../../packages/adapters/src/import-native.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import {
  apply,
  initialState,
  type RecordingState,
} from "../../packages/playback/src/index.js";
import { openArchive } from "../../packages/storage/src/archive.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
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
    version: 2,
    reason: "frozen-native-source",
    unfinishedMessages: 0,
    unfinishedTools: 1,
    withheldTextMessages: 0,
    runningTasks: 0,
    pendingInteractions: 0,
    pendingAttachments: 0,
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
  ).toBe(2);
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
        expect(_added).toBe(2);
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

const time = Date.parse("2026-09-09T00:00:00Z");
const kimi = (rows: object[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const kimiMetadata = {
  type: "metadata",
  protocol_version: "1.5",
  created_at: time,
};
const kimiTask = {
  type: "task.started",
  time,
  info: {
    taskId: "task1",
    kind: "process",
    status: "running",
    description: "Monitor",
  },
};
const kimiApproval = {
  type: "interaction.request",
  time,
  id: "approval1",
  kind: "approval",
  request: { toolName: "Shell", action: "Run command" },
};
async function kimiSetup(rows: object[]) {
  const context = await setup(kimi(rows));
  const sourcePath = join(context.root, "wire.jsonl");
  await writeFile(sourcePath, kimi(rows));
  return {
    ...context,
    options: {
      ...context.options,
      sourcePath,
      nativeIdentity: { nativeSessionId: "kimi_frozen", agentId: "root" },
      title: "Frozen Kimi session",
    },
  };
}
/** Pin a fresh binding to an older notice version before any capture, as an
 * import created by an earlier release would have been. */
async function pinVersion1(
  context: Awaited<ReturnType<typeof kimiSetup>>,
): Promise<string> {
  let directory = "";
  await expect(
    importKimiRecording({
      ...context.options,
      beforeImport: async (identity, target) => {
        directory = target;
        await writeFile(
          join(target, "import.json"),
          JSON.stringify({ ...identity, completenessNotice: 1 }),
        );
        throw new Error("stop before capture");
      },
    }),
  ).rejects.toThrow("stop before capture");
  return directory;
}
const noticesOf = (events: StoredEvent[]) =>
  events
    .filter((event) => event.content.kind === "capture.completeness")
    .map((event) => event.content.payload);
it("counts Kimi running tasks and pending interactions in version 2 notices", async () => {
  const context = await kimiSetup([kimiMetadata, kimiTask, kimiApproval]);
  const first = await importKimiRecording(context.options);
  const before = await history(context.server, first.streamId);
  // The running background task is also a normalized tool that never completed.
  expect(noticesOf(before.events)).toEqual([
    {
      version: 2,
      reason: "frozen-native-source",
      unfinishedMessages: 0,
      unfinishedTools: 1,
      withheldTextMessages: 0,
      runningTasks: 1,
      pendingInteractions: 1,
      pendingAttachments: 0,
    },
  ]);
  expect(before.events.at(-2)!.content.kind).toBe("capture.completeness");
  expect(before.state.completeness).toMatchObject({
    version: 2,
    runningTasks: 1,
    pendingInteractions: 1,
  });
  const directory = join(
    context.options.publisherRoot,
    (await readdir(context.options.publisherRoot))[0]!,
  );
  expect(
    JSON.parse(await readFile(join(directory, "import.json"), "utf8"))
      .completenessNotice,
  ).toBe(2);
  expect(await importKimiRecording(context.options)).toEqual(first);
  expect((await history(context.server, first.streamId)).events).toEqual(
    before.events,
  );
  const archive = join(context.root, "kimi.agentlive");
  await exportRecording({
    serverOrigin: context.server.url,
    streamId: first.streamId,
    output: archive,
    credential: owner,
    signal: context.options.signal,
  });
  const opened = await openArchive(archive);
  try {
    expect(opened.manifest.provenance.completenessNotice).toEqual(
      before.state.completeness,
    );
  } finally {
    await opened.close();
  }
  // A pending interaction alone is enough for a version 2 notice.
  const only = await kimiSetup([kimiMetadata, kimiApproval]);
  const approval = await importKimiRecording(only.options);
  expect(
    noticesOf((await history(only.server, approval.streamId)).events),
  ).toEqual([
    expect.objectContaining({
      version: 2,
      unfinishedTools: 0,
      runningTasks: 0,
      pendingInteractions: 1,
    }),
  ]);
});
it("keeps version 1 pinned bindings on their original payload and emission rule across retries", async () => {
  const context = await kimiSetup([kimiMetadata, kimiTask, kimiApproval]);
  const directory = await pinVersion1(context);
  const first = await importKimiRecording(context.options);
  const before = await history(context.server, first.streamId);
  // Exactly the payload an earlier release emitted: no task/interaction counts.
  expect(noticesOf(before.events)).toEqual([
    {
      version: 1,
      reason: "frozen-native-source",
      unfinishedMessages: 0,
      unfinishedTools: 1,
      withheldTextMessages: 0,
    },
  ]);
  expect(before.state.completeness).toEqual({
    ...noticesOf(before.events)[0],
    at: before.events.at(-2)!.serverSeq,
  });
  expect(
    JSON.parse(await readFile(join(directory, "import.json"), "utf8"))
      .completenessNotice,
  ).toBe(1);
  expect(await importKimiRecording(context.options)).toEqual(first);
  expect((await history(context.server, first.streamId)).events).toEqual(
    before.events,
  );
  // Version 1 emitted nothing when only an interaction was pending; neither do its retries.
  const only = await kimiSetup([kimiMetadata, kimiApproval]);
  await pinVersion1(only);
  const approval = await importKimiRecording(only.options);
  const events = (await history(only.server, approval.streamId)).events;
  expect(noticesOf(events)).toEqual([]);
  expect(await importKimiRecording(only.options)).toEqual(approval);
  expect((await history(only.server, approval.streamId)).events).toEqual(
    events,
  );
  // Unknown pins are rejected instead of silently re-pinned.
  const unknown = await kimiSetup([kimiMetadata, kimiApproval]);
  const target = await pinVersion1(unknown);
  const manifest = JSON.parse(
    await readFile(join(target, "import.json"), "utf8"),
  );
  await writeFile(
    join(target, "import.json"),
    JSON.stringify({ ...manifest, completenessNotice: 3 }),
  );
  await expect(importKimiRecording(unknown.options)).rejects.toThrow(
    "unsupported completeness notice version",
  );
});
it("counts only visible attachments still pending at the frozen boundary, idempotently per version", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-notice-journal-"));
  roots.push(root);
  const attachment = (artifactId: string) => ({
    artifactId,
    version: 1,
    hash: "a".repeat(64),
    filename: `${artifactId}.png`,
    mediaType: "image/png",
    byteSize: 1,
  });
  const content: EventContent[] = [
    {
      kind: "attachment.pending",
      payload: { artifactId: "open", filename: "open.png" },
    },
    {
      kind: "attachment.pending",
      payload: { artifactId: "hidden", filename: "hidden.png" },
    },
    {
      kind: "object.visibility",
      payload: { objectType: "attachment", objectId: "hidden", visible: false },
    },
    {
      kind: "attachment.pending",
      payload: { artifactId: "ready", filename: "ready.png" },
    },
    {
      kind: "attachment.available",
      payload: { attachment: attachment("ready") },
    },
    {
      kind: "attachment.pending",
      payload: { artifactId: "lost", filename: "lost.png" },
    },
    {
      kind: "attachment.unavailable",
      payload: { artifactId: "lost", reason: "gone" },
    },
    // A new version pending after an available one is unfinished again.
    {
      kind: "attachment.available",
      payload: { attachment: attachment("again") },
    },
    {
      kind: "attachment.pending",
      payload: { artifactId: "again", filename: "again.png" },
    },
    {
      kind: "task.updated",
      payload: {
        taskId: "unknown",
        taskType: "unknown",
        status: "unknown",
        description: "Not claimed as running",
      },
    },
  ];
  const journalAt = async (name: string) => {
    const journal = await PublisherJournal.open(join(root, name), {
      serverOrigin: "https://example.test",
      agent: "claude",
      nativeSessionId: "native",
    });
    await journal.bindRemote("stream", "revision");
    await journal.capture({
      sourceKey: "source",
      observedAt: "2026-09-09T00:00:00Z",
      clockSegmentId: "clock",
      elapsedMs: 10,
      fidelity: "reconstructed",
      adapterState: null,
      content,
    });
    return journal;
  };
  const signal = AbortSignal.timeout(10000);
  const current = await journalAt("v2");
  try {
    const notice = await captureCompletenessNotice(current, 0, signal);
    expect(notice).toEqual({
      version: 2,
      reason: "frozen-native-source",
      unfinishedMessages: 0,
      unfinishedTools: 0,
      withheldTextMessages: 0,
      runningTasks: 0,
      pendingInteractions: 0,
      pendingAttachments: 2,
    });
    const through = current.capturedThrough;
    expect(await captureCompletenessNotice(current, 0, signal, 2)).toEqual(
      notice,
    );
    expect(current.capturedThrough).toBe(through);
    const recorded = [];
    for await (const event of current.pending(0))
      if (event.source.eventId === IMPORT_COMPLETENESS_SOURCE_KEY)
        recorded.push(event);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.elapsedMs).toBe(10);
  } finally {
    await current.close();
  }
  const pinned = await journalAt("v1");
  try {
    // Version 1 never counted attachments, so nothing is emitted.
    expect(
      await captureCompletenessNotice(pinned, 0, signal, 1),
    ).toBeUndefined();
    expect(pinned.capturedThrough).toBe(content.length);
    // With withheld text the version 1 payload is emitted unchanged, and a different
    // version under the same source key would be a changed-content retry.
    expect(await captureCompletenessNotice(pinned, 1, signal, 1)).toEqual({
      version: 1,
      reason: "frozen-native-source",
      unfinishedMessages: 0,
      unfinishedTools: 0,
      withheldTextMessages: 1,
    });
    await expect(
      captureCompletenessNotice(pinned, 1, signal, 2),
    ).rejects.toMatchObject({ code: "event_conflict" });
  } finally {
    await pinned.close();
  }
});
