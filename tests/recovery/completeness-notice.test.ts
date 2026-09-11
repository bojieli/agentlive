import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  openArchive,
  writeArchive,
  type ArchiveMetadata,
} from "../../packages/storage/src/archive.js";
import {
  ActivityIndex,
  PagedReducer,
  PagedTerminalRenderer,
  SnapshotReader,
  apply,
  completenessSummary,
  createSnapshot,
  initialActivityIndex,
  initialPagedState,
  initialState,
  renderTerminalEvent,
  renderTerminalPending,
  renderTerminalSnapshot,
  unfinishedActivity,
  type RecordingState,
} from "../../packages/playback/src/index.js";
import {
  archiveManifestSchema,
  contentSchema,
  type EventContent,
  type StoredEvent,
} from "../../packages/protocol/src/index.js";
import { PagedActivityView } from "../../apps/web/src/paged-activity.js";
import { CompletenessNotice } from "../../apps/web/src/completeness-notice.js";
import { ActivityFeed } from "../../apps/web/src/activity-feed.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const binding = { streamId: "stream", revision: "revision" };
const notice = {
  version: 1 as const,
  reason: "frozen-native-source" as const,
  unfinishedMessages: 1,
  unfinishedTools: 1,
  withheldTextMessages: 2,
};
const event = (seq: number, content: EventContent): StoredEvent => ({
  protocolVersion: 1,
  serverSeq: seq,
  timelineMs: seq * 10,
  receivedAt: "2026-09-11T00:00:00Z",
  origin: { type: "server", operationId: `event-${seq}` },
  content,
});
const frozen: EventContent[] = [
  { kind: "recording.created", payload: { title: "Frozen import" } },
  {
    kind: "message.started",
    payload: { messageId: "done", role: "user" },
  },
  { kind: "message.text.append", payload: { messageId: "done", text: "hi" } },
  { kind: "message.completed", payload: { messageId: "done" } },
  {
    kind: "message.started",
    payload: { messageId: "partial", role: "assistant" },
  },
  {
    kind: "message.text.append",
    payload: { messageId: "partial", text: "Visible " },
  },
  {
    kind: "tool.started",
    payload: { toolId: "running", name: "shell", input: "sleep 100" },
  },
  { kind: "capture.completeness", payload: notice },
  {
    kind: "recording.ended",
    payload: { producerEpoch: "epoch", throughProducerSeq: 7 },
  },
];
const noticeV2 = {
  version: 2 as const,
  reason: "frozen-native-source" as const,
  unfinishedMessages: 1,
  unfinishedTools: 1,
  withheldTextMessages: 0,
  runningTasks: 2,
  pendingInteractions: 1,
  pendingAttachments: 1,
};
/** Two running tasks, one pending interaction and one visible pending attachment. */
const workflow: EventContent[] = [
  {
    kind: "task.updated",
    payload: {
      taskId: "task-process",
      taskType: "process",
      status: "running",
      description: "Monitor",
    },
  },
  {
    kind: "task.updated",
    payload: {
      taskId: "task-agent",
      taskType: "agent",
      status: "running",
      description: "Child agent",
    },
  },
  {
    kind: "task.updated",
    payload: {
      taskId: "task-done",
      taskType: "process",
      status: "completed",
      description: "Build",
    },
  },
  {
    kind: "task.updated",
    payload: {
      taskId: "task-unknown",
      taskType: "unknown",
      status: "unknown",
      description: "Unclassified",
    },
  },
  {
    kind: "interaction.updated",
    payload: {
      interactionId: "approval",
      interactionType: "approval",
      status: "pending",
      title: "Shell",
      prompt: "Run command",
    },
  },
  {
    kind: "interaction.updated",
    payload: {
      interactionId: "answered",
      interactionType: "question",
      status: "resolved",
      title: "Question",
      prompt: "Which?",
      response: "A",
    },
  },
  {
    kind: "attachment.pending",
    payload: { artifactId: "upload", filename: "report.pdf" },
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
    payload: { artifactId: "missing", filename: "gone.bin" },
  },
  {
    kind: "attachment.unavailable",
    payload: { artifactId: "missing", reason: "not captured" },
  },
];
const frozenV2: EventContent[] = [
  ...frozen.slice(0, 7),
  ...workflow,
  { kind: "capture.completeness", payload: noticeV2 },
  frozen.at(-1)!,
];
async function reduceBoth(contents: EventContent[]) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-completeness-"));
  roots.push(root);
  const store = await TextStore.open(root);
  const reducer = new PagedReducer(store);
  let reference = initialState(),
    paged = initialPagedState();
  const events = contents.map((content, index) => event(index + 1, content));
  for (const item of events) {
    reference = apply(reference, item);
    paged = await reducer.apply(paged, item);
    expect(await reducer.materialize(paged)).toStrictEqual(reference);
  }
  return { store, reducer, reference, paged, events };
}
const collect = async (chunks: AsyncIterable<string>) => {
  let output = "";
  for await (const chunk of chunks) output += chunk;
  return output;
};
it("reduces persisted notices identically, survives checkpoints and clears on reopen", async () => {
  const { store, reducer, reference, paged, events } = await reduceBoth(frozen);
  try {
    expect(reference.completeness).toEqual({ ...notice, at: 8 });
    expect(paged.completeness).toEqual({ ...notice, at: 8 });
    const checkpoint = await reducer.checkpoint(paged, binding);
    const reopened = await reducer.open(checkpoint, binding);
    expect(reopened.completeness).toEqual({ ...notice, at: 8 });
    expect(await reducer.applyBatch(initialPagedState(), events)).toStrictEqual(
      paged,
    );
    // A later reopen means continued capture may resolve the counted work.
    const reopen = event(10, { kind: "recording.reopened", payload: {} });
    const afterReference = apply(reference, reopen);
    const afterPaged = await reducer.apply(paged, reopen);
    expect("completeness" in afterReference).toBe(false);
    expect("completeness" in afterPaged).toBe(false);
    expect(await reducer.materialize(afterPaged)).toStrictEqual(afterReference);
    // A later notice replaces the earlier one.
    const second = event(11, {
      kind: "capture.completeness",
      payload: { ...notice, withheldTextMessages: 0 },
    });
    expect(apply(afterReference, second).completeness).toEqual({
      ...notice,
      withheldTextMessages: 0,
      at: 11,
    });
    await expect(
      reducer.apply({ ...paged, completeness: { ...notice, at: 99 } }, reopen),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    await expect(
      reducer.apply(
        {
          ...paged,
          completeness: { ...notice, extra: true } as never,
        },
        reopen,
      ),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    // The retired snapshot codec accepts the optional notice and still requires the rest.
    const legacy = await createSnapshot(reference, binding, store);
    const reader = await SnapshotReader.open(legacy, binding, store);
    expect(
      ((await reader.materialize()) as RecordingState).completeness,
    ).toEqual({ ...notice, at: 8 });
    const index = new ActivityIndex(store);
    let rows = initialActivityIndex(),
      state = initialPagedState();
    for (const item of events) {
      state = await reducer.apply(state, item);
      rows = await index.apply(rows, item, state, reducer);
    }
    expect(rows.gaps).toBe(0);
    expect((await index.entries(rows, 0, 32)).map((row) => row.key)).toEqual([
      "messages/done",
      "messages/partial",
      "tools/running",
    ]);
  } finally {
    await store.close();
  }
});
it("keeps recordings without the event byte-identical and derives ended notices at replay", async () => {
  const withoutNotice = frozen.filter(
    (content) => content.kind !== "capture.completeness",
  );
  const { store, reducer, reference, paged } = await reduceBoth(
    withoutNotice.map((content) =>
      content.kind === "recording.ended"
        ? { ...content, payload: { ...content.payload, throughProducerSeq: 6 } }
        : content,
    ),
  );
  try {
    expect("completeness" in reference).toBe(false);
    expect("completeness" in paged).toBe(false);
    const checkpoint = await reducer.checkpoint(paged, binding);
    expect(await store.read(checkpoint, 0, checkpoint.units)).not.toContain(
      "completeness",
    );
    const derived = completenessSummary(reference, {
      unfinishedMessages: 1,
      unfinishedTools: 1,
    });
    expect(derived).toEqual({
      source: "derived",
      unfinishedMessages: 1,
      unfinishedTools: 1,
      runningTasks: 0,
      pendingInteractions: 0,
      pendingAttachments: 0,
      exhaustive: true,
    });
    const pending = [...renderTerminalPending(reference)].join("");
    expect(pending).toContain(
      "Incomplete activity: the recording ended before some captured work finished",
    );
    expect(pending).toContain("1 message never completed.");
    expect(pending).toContain("1 tool call never completed.");
    const renderer = new PagedTerminalRenderer(
      reducer,
      store,
      "https://example.test",
      "stream",
    );
    expect(
      await collect(renderer.pending(paged, AbortSignal.timeout(10000))),
    ).toBe(pending);
    // Open boundaries are still capturing; no derived notice is shown.
    const open: RecordingState = { ...reference, lifecycle: "open" };
    expect([...renderTerminalPending(open)].join("")).not.toContain(
      "Incomplete activity",
    );
    expect(
      completenessSummary(open, { unfinishedMessages: 1, unfinishedTools: 0 }),
    ).toBeUndefined();
    const view = new PagedActivityView(reducer, paged, () => {
      throw new Error("No text reads");
    });
    expect(await view.completeness(AbortSignal.timeout(10000))).toEqual(
      derived,
    );
    // A bounded scan checks the most recent entries and reports a lower bound.
    expect(await view.completeness(AbortSignal.timeout(10000), 1)).toEqual({
      ...derived,
      exhaustive: false,
    });
    const markup = renderToStaticMarkup(
      createElement(CompletenessNotice, {
        summary: { ...derived!, exhaustive: false },
      }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("At least 1 message never completed.");
    const feed = renderToStaticMarkup(
      createElement(ActivityFeed, {
        state: reference,
        following: false,
        onPause: () => {},
        order: () => 0,
        onAttachment: () => {},
      }),
    );
    expect(feed).toContain('aria-label="Recording completeness"');
    expect(feed).toContain("1 tool call never completed.");
  } finally {
    await store.close();
  }
});
it("renders persisted notices in terminal event, snapshot and browser output without deriving twice", async () => {
  const { store, reducer, reference, paged, events } = await reduceBoth(frozen);
  try {
    const noticeEvent = events[7]!;
    const text = renderTerminalEvent(
      noticeEvent,
      reference,
      "https://example.test",
      "stream",
    );
    expect(text).toBe(
      "[0.080s] Incomplete capture: the native session was unfinished when this recording was imported\n" +
        "  1 message never completed.\n" +
        "  1 tool call never completed.\n" +
        "  2 messages have trailing text withheld because it may begin a redacted secret; the withheld text is not part of this recording.\n" +
        "  Content shown for unfinished items is partial.\n\n",
    );
    const renderer = new PagedTerminalRenderer(
      reducer,
      store,
      "https://example.test",
      "stream",
    );
    expect(
      await collect(
        renderer.event(noticeEvent, paged, AbortSignal.timeout(10000)),
      ),
    ).toBe(text);
    const snapshot = [
      ...renderTerminalSnapshot(reference, "https://example.test", "stream"),
    ].join("");
    expect(snapshot).toContain("Incomplete capture:");
    expect(snapshot).not.toContain("Incomplete activity:");
    expect(
      await collect(renderer.snapshot(paged, AbortSignal.timeout(10000))),
    ).toBe(snapshot);
    const view = new PagedActivityView(reducer, paged, () => {
      throw new Error("No text reads");
    });
    expect(view.summary.completeness).toEqual({ ...notice, at: 8 });
    const summary = await view.completeness(AbortSignal.timeout(10000));
    expect(summary).toEqual({ source: "recorded", ...notice, at: 8 });
    const markup = renderToStaticMarkup(
      createElement(CompletenessNotice, { summary }),
    );
    expect(markup).toContain('data-source="recorded"');
    expect(markup).toContain("2 messages have trailing text withheld");
    expect(markup).not.toContain("Visible");
  } finally {
    await store.close();
  }
});
it("records the effective notice in archive provenance and rejects mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-notice-archive-"));
  roots.push(directory);
  const events = frozen.map((content, index) => event(index + 1, content));
  const metadata: ArchiveMetadata = {
    format: "agentlive.recording",
    version: 1,
    protocolVersion: 1,
    reducerVersion: 1,
    exportedAt: "2026-09-11T00:00:00Z",
    recording: {
      streamId: "source",
      revision: "revision",
      title: "Frozen import",
      createdAt: "2026-09-11T00:00:00Z",
      throughServerSeq: events.length,
      timelineMs: events.at(-1)!.timelineMs,
      lifecycle: "ended",
    },
    provenance: {
      agent: null,
      sourceVersion: null,
      adapterVersion: null,
      capabilities: [],
      completeness: "ended-recording",
      gapCount: 0,
      completenessNotice: { ...notice, at: 8 },
    },
  };
  const none = async () => Readable.from([]);
  const source = async function* () {
    yield* events;
  };
  const path = join(directory, "notice.agentlive");
  await writeArchive(path, metadata, source(), none);
  const archive = await openArchive(path);
  try {
    expect(archive.manifest.provenance.completenessNotice).toEqual({
      ...notice,
      at: 8,
    });
  } finally {
    await archive.close();
  }
  const { completenessNotice: _omitted, ...withoutNotice } =
    metadata.provenance;
  await expect(
    writeArchive(
      join(directory, "missing.agentlive"),
      { ...metadata, provenance: withoutNotice },
      source(),
      none,
    ),
  ).rejects.toThrow("manifest boundary/count mismatch");
  await expect(
    writeArchive(
      join(directory, "stale.agentlive"),
      {
        ...metadata,
        provenance: {
          ...metadata.provenance,
          completenessNotice: { ...notice, at: 7 },
        },
      },
      source(),
      none,
    ),
  ).rejects.toThrow("manifest boundary/count mismatch");
  // Version 1 manifests without the field remain valid.
  expect(
    archiveManifestSchema.safeParse({
      ...metadata,
      provenance: withoutNotice,
      files: [{ path: "events.jsonl", byteSize: 1, hash: "0".repeat(64) }],
    }).success,
  ).toBe(true);
  expect(
    contentSchema.safeParse({
      kind: "capture.completeness",
      payload: { ...notice, text: "content" },
    }).success,
  ).toBe(false);
});
it("reduces, checkpoints and renders version 2 notices with task, interaction and attachment counts", async () => {
  const { store, reducer, reference, paged, events } =
    await reduceBoth(frozenV2);
  try {
    expect(reference.completeness).toEqual({ ...noticeV2, at: 19 });
    expect(paged.completeness).toEqual({ ...noticeV2, at: 19 });
    // The viewer derivation over the same boundary agrees with the importer counts.
    const {
      version: _v,
      reason: _r,
      withheldTextMessages: _w,
      ...counts
    } = noticeV2;
    expect(unfinishedActivity(reference)).toEqual(counts);
    const reopened = await reducer.open(
      await reducer.checkpoint(paged, binding),
      binding,
    );
    expect(reopened).toStrictEqual(paged);
    expect(await reducer.applyBatch(initialPagedState(), events)).toStrictEqual(
      paged,
    );
    const noticeEvent = events[18]!;
    const text = renderTerminalEvent(
      noticeEvent,
      reference,
      "https://example.test",
      "stream",
    );
    expect(text).toBe(
      "[0.190s] Incomplete capture: the native session was unfinished when this recording was imported\n" +
        "  1 message never completed.\n" +
        "  1 tool call never completed.\n" +
        "  2 tasks were still running.\n" +
        "  1 approval or question was still awaiting a response.\n" +
        "  1 attachment was still pending.\n" +
        "  Content shown for unfinished items is partial.\n\n",
    );
    const renderer = new PagedTerminalRenderer(
      reducer,
      store,
      "https://example.test",
      "stream",
    );
    expect(
      await collect(
        renderer.event(noticeEvent, paged, AbortSignal.timeout(10000)),
      ),
    ).toBe(text);
    const snapshot = [
      ...renderTerminalSnapshot(reference, "https://example.test", "stream"),
    ].join("");
    expect(snapshot).toContain("2 tasks were still running.");
    expect(snapshot).not.toContain("Incomplete activity:");
    expect(
      await collect(renderer.snapshot(paged, AbortSignal.timeout(10000))),
    ).toBe(snapshot);
    const view = new PagedActivityView(reducer, paged, () => {
      throw new Error("No text reads");
    });
    const summary = await view.completeness(AbortSignal.timeout(10000));
    expect(summary).toEqual({ source: "recorded", ...noticeV2, at: 19 });
    const markup = renderToStaticMarkup(
      createElement(CompletenessNotice, { summary }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("1 approval or question was still awaiting");
    expect(markup).not.toContain("report.pdf");
    // A later version 2 notice replaces a version 1 notice in both reducers.
    const v1 = await reduceBoth(frozen.slice(0, 8));
    try {
      const next = event(9, {
        kind: "capture.completeness",
        payload: noticeV2,
      });
      const afterReference = apply(v1.reference, next);
      const afterPaged = await v1.reducer.apply(v1.paged, next);
      expect(afterReference.completeness).toEqual({ ...noticeV2, at: 9 });
      expect(await v1.reducer.materialize(afterPaged)).toStrictEqual(
        afterReference,
      );
    } finally {
      await v1.store.close();
    }
    // Payload versions are strict: no mixed or unknown shapes.
    const { runningTasks: _t, ...missing } = noticeV2;
    for (const payload of [
      missing,
      { ...notice, runningTasks: 1 },
      { ...noticeV2, version: 3 },
    ])
      expect(
        contentSchema.safeParse({ kind: "capture.completeness", payload })
          .success,
      ).toBe(false);
    await expect(
      reducer.apply(
        {
          ...paged,
          completeness: { ...noticeV2, version: 1, at: 19 } as never,
        },
        event(21, { kind: "recording.reopened", payload: {} }),
      ),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
  } finally {
    await store.close();
  }
});
it("derives running tasks, pending interactions and pending attachments at ended boundaries", async () => {
  // Only the new categories are unfinished: derivation must not depend on messages/tools.
  const contents: EventContent[] = [
    frozen[0]!,
    ...workflow,
    {
      kind: "recording.ended",
      payload: { producerEpoch: "epoch", throughProducerSeq: 11 },
    },
  ];
  const { store, reducer, reference, paged } = await reduceBoth(contents);
  try {
    const checkpoint = await reducer.checkpoint(paged, binding);
    expect(await store.read(checkpoint, 0, checkpoint.units)).not.toContain(
      "completeness",
    );
    const expected = {
      source: "derived",
      unfinishedMessages: 0,
      unfinishedTools: 0,
      runningTasks: 2,
      pendingInteractions: 1,
      pendingAttachments: 1,
      exhaustive: true,
    };
    expect(
      completenessSummary(reference, unfinishedActivity(reference)),
    ).toEqual(expected);
    const pending = [...renderTerminalPending(reference)].join("");
    expect(pending).toContain(
      "Incomplete activity: the recording ended before some captured work finished\n" +
        "  2 tasks were still running.\n" +
        "  1 approval or question was still awaiting a response.\n" +
        "  1 attachment was still pending.\n",
    );
    expect(pending).not.toContain("message never completed");
    const renderer = new PagedTerminalRenderer(
      reducer,
      store,
      "https://example.test",
      "stream",
    );
    expect(
      await collect(renderer.pending(paged, AbortSignal.timeout(10000))),
    ).toBe(pending);
    expect(
      await collect(renderer.snapshot(paged, AbortSignal.timeout(10000))),
    ).toBe(
      [
        ...renderTerminalSnapshot(reference, "https://example.test", "stream"),
      ].join(""),
    );
    const view = new PagedActivityView(reducer, paged, () => {
      throw new Error("No text reads");
    });
    expect(await view.completeness(AbortSignal.timeout(10000))).toEqual(
      expected,
    );
    // Bounded scans check only the most recent entries of each map: a lower bound.
    const bounded = await view.completeness(AbortSignal.timeout(10000), 3);
    expect(bounded).toMatchObject({ source: "derived", exhaustive: false });
    for (const key of [
      "runningTasks",
      "pendingInteractions",
      "pendingAttachments",
    ] as const)
      expect((bounded as typeof expected)[key]).toBeLessThanOrEqual(
        expected[key],
      );
    const markup = renderToStaticMarkup(
      createElement(CompletenessNotice, {
        summary: { ...expected, exhaustive: false } as never,
      }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("At least 2 tasks were still running.");
    const feed = renderToStaticMarkup(
      createElement(ActivityFeed, {
        state: reference,
        following: false,
        onPause: () => {},
        order: () => 0,
        onAttachment: () => {},
      }),
    );
    expect(feed).toContain('aria-label="Recording completeness"');
    expect(feed).toContain("1 attachment was still pending.");
    // Open boundaries are still capturing.
    const open: RecordingState = { ...reference, lifecycle: "open" };
    expect([...renderTerminalPending(open)].join("")).not.toContain(
      "Incomplete activity",
    );
    // A version 1 notice predates these counts and never reports them.
    const recorded = completenessSummary({
      ...reference,
      completeness: { ...notice, at: 1 },
    });
    expect(recorded).toEqual({ source: "recorded", ...notice, at: 1 });
  } finally {
    await store.close();
  }
});
it("accepts version 1 and version 2 notices in archive provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-notice-v2-"));
  roots.push(directory);
  const events = frozenV2.map((content, index) => event(index + 1, content));
  const metadata: ArchiveMetadata = {
    format: "agentlive.recording",
    version: 1,
    protocolVersion: 1,
    reducerVersion: 1,
    exportedAt: "2026-09-11T00:00:00Z",
    recording: {
      streamId: "source",
      revision: "revision",
      title: "Frozen import",
      createdAt: "2026-09-11T00:00:00Z",
      throughServerSeq: events.length,
      timelineMs: events.at(-1)!.timelineMs,
      lifecycle: "ended",
    },
    provenance: {
      agent: null,
      sourceVersion: null,
      adapterVersion: null,
      capabilities: [],
      completeness: "ended-recording",
      gapCount: 0,
      completenessNotice: { ...noticeV2, at: 19 },
    },
  };
  const none = async () => Readable.from([]);
  const source = async function* () {
    yield* events;
  };
  const path = join(directory, "v2.agentlive");
  await writeArchive(path, metadata, source(), none);
  const archive = await openArchive(path);
  try {
    expect(archive.manifest.provenance.completenessNotice).toEqual({
      ...noticeV2,
      at: 19,
    });
  } finally {
    await archive.close();
  }
  // A v1-shaped provenance for a v2 event is a mismatch, not a silent downgrade.
  const { runningTasks, pendingInteractions, pendingAttachments, ...v1Counts } =
    noticeV2;
  expect(runningTasks + pendingInteractions + pendingAttachments).toBe(4);
  await expect(
    writeArchive(
      join(directory, "downgraded.agentlive"),
      {
        ...metadata,
        provenance: {
          ...metadata.provenance,
          completenessNotice: { ...v1Counts, version: 1, at: 19 },
        },
      },
      source(),
      none,
    ),
  ).rejects.toThrow("manifest boundary/count mismatch");
  for (const completenessNotice of [
    { ...notice, at: 8 },
    { ...noticeV2, at: 19 },
  ])
    expect(
      archiveManifestSchema.safeParse({
        ...metadata,
        provenance: { ...metadata.provenance, completenessNotice },
        files: [{ path: "events.jsonl", byteSize: 1, hash: "0".repeat(64) }],
      }).success,
    ).toBe(true);
});
