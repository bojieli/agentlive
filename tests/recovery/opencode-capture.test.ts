import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeCapture,
  parseOpenCodeSnapshot,
} from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { OpenCodeFamilyCapture } from "../../packages/adapters/src/opencode-family.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
const roots: string[] = [];
const journals: PublisherJournal[] = [];
const captures: OpenCodeCapture[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const capture of captures.splice(0)) await capture.close();
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-capture-"));
  roots.push(root);
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "http://localhost",
    agent: "opencode",
    nativeSessionId: "ses_test",
  });
  journals.push(journal);
  await journal.bindRemote("stream1", "revision1");
  return journal;
}
function snapshot(text: string, complete = false, toolStatus?: string) {
  return parseOpenCodeSnapshot({
    info: { id: "ses_test", time: { created: 1 } },
    messages: [
      {
        info: {
          id: "msg1",
          sessionID: "ses_test",
          role: "assistant",
          time: { created: 1, ...(complete ? { completed: 2 } : {}) },
        },
        parts: [
          {
            id: "part1",
            messageID: "msg1",
            sessionID: "ses_test",
            type: "text",
            text,
          },
          ...(toolStatus
            ? [
                {
                  id: "tool1",
                  messageID: "msg1",
                  sessionID: "ses_test",
                  type: "tool",
                  tool: "bash",
                  state: {
                    status: toolStatus,
                    input: { command: "echo token_abcdef" },
                    output: "done token_abcdef",
                  },
                },
              ]
            : []),
        ],
      },
    ],
  });
}
async function replay(journal: PublisherJournal) {
  let state = initialState();
  const events = [];
  for await (const event of journal.pending(0)) {
    events.push(event);
    state = apply(state, {
      protocolVersion: 1,
      serverSeq: event.producerSeq,
      receivedAt: event.observedAt,
      timelineMs: Math.max(state.timelineMs, event.elapsedMs),
      content: event.content,
      origin: { type: "server", operationId: `test${event.producerSeq}` },
    });
  }
  return { state, events };
}
it.each(["changed", "missing"])(
  "retains explicit parent lineage across restart and rejects %s lineage",
  async (variant) => {
    const journal = await setup();
    let capture = await OpenCodeCapture.open(journal);
    const child = snapshot("child message", true);
    child.info.parentID = "ses_parent";
    await capture.accept(child);
    const before = await replay(journal);
    const agents = [...before.state.agents.values()];
    const parent = agents.find(
      (agent) => agent.nativeSessionId === "ses_parent",
    )!;
    expect(parent.status).toBe("unknown");
    expect(
      agents.find((agent) => agent.nativeSessionId === "ses_test"),
    ).toMatchObject({ parentAgentId: parent.agentId, status: "unknown" });
    await capture.close();
    capture = await OpenCodeCapture.open(journal);
    captures.push(capture);
    await capture.accept(child);
    expect((await replay(journal)).events).toHaveLength(before.events.length);
    if (variant === "changed") child.info.parentID = "ses_other";
    else delete child.info.parentID;
    await expect(capture.accept(child)).rejects.toThrow(
      variant === "changed" ? "identity changed" : "identity disappeared",
    );
  },
);

it("rejects invalid and self-referencing native parent identities", () => {
  const child = snapshot("child", true);
  child.info.parentID = "ses_test";
  expect(() => parseOpenCodeSnapshot(child)).toThrow("own parent");
  child.info.parentID = "../bad";
  expect(() => parseOpenCodeSnapshot(child)).toThrow();
});

it("recursively reconciles a family, discovers later children and rejects unrelated snapshots", async () => {
  const journal = await setup();
  const nodes: Record<string, { parent: string; text: string }> = {
    child: { parent: "ses_test", text: "child text" },
    grandchild: { parent: "child", text: "grandchild text" },
  };
  let foreign = false;
  vi.stubGlobal("fetch", (async (input) => {
    const parts = new URL(String(input)).pathname.split("/");
    const id = parts[2]!;
    if (parts[3] === "children")
      return Response.json(
        Object.entries(nodes)
          .filter(([, node]) => node.parent === id)
          .map(([child, node]) => ({
            id: child,
            parentID: node.parent,
            time: { created: 1 },
          })),
      );
    const node = nodes[id]!;
    if (!parts[3])
      return Response.json({
        id,
        parentID: foreign ? "unrelated" : node.parent,
        time: { created: 1 },
      });
    return Response.json([
      {
        info: {
          id: "same_message",
          sessionID: id,
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "same_part",
            sessionID: id,
            messageID: "same_message",
            type: "text",
            text: node.text,
          },
        ],
      },
    ]);
  }) as typeof fetch);
  let family = new OpenCodeFamilyCapture({
    journal,
    origin: "http://localhost",
    root: "ses_test",
    secrets: [],
  });
  try {
    await family.reconcile(new AbortController().signal);
    expect(
      [...(await replay(journal)).state.messages.values()].map((m) => m.text),
    ).toEqual(["child text", "grandchild text"]);
    const before = journal.capturedThrough;
    await family.close();
    family = new OpenCodeFamilyCapture({
      journal,
      origin: "http://localhost",
      root: "ses_test",
      secrets: [],
    });
    await family.reconcile(new AbortController().signal);
    expect(journal.capturedThrough).toBe(before);
    nodes.later = { parent: "ses_test", text: "later child" };
    await family.reconcile(new AbortController().signal);
    expect((await replay(journal)).state.messages.size).toBe(3);
    foreign = true;
    await expect(
      family.reconcile(new AbortController().signal),
    ).rejects.toThrow("identity changed");
  } finally {
    await family.close();
  }
});

it("merges child messages with colliding native object IDs without replacing parent content", async () => {
  const journal = await setup();
  const root = await OpenCodeCapture.open(journal);
  captures.push(root);
  await root.accept(snapshot("parent message", true, "completed"));
  const scope = {
    nativeSessionId: "ses_child",
    parentNativeSessionId: "ses_test",
  };
  let child = await OpenCodeCapture.open(journal, [], undefined, scope);
  captures.push(child);
  const data = snapshot("child message", true, "completed");
  data.info.id = "ses_child";
  data.info.parentID = "ses_test";
  for (const message of data.messages) {
    message.info.sessionID = "ses_child";
    for (const part of message.parts) part.sessionID = "ses_child";
  }
  await child.accept(data);
  const before = await replay(journal);
  expect(
    [...before.state.messages.values()].map((message) => message.text),
  ).toEqual(["parent message", "child message"]);
  expect(before.state.tools.size).toBe(2);
  expect(
    before.events.filter((event) => event.content.kind === "session.started"),
  ).toHaveLength(1);
  const childAgent = [...before.state.agents.values()].find(
    (agent) => agent.nativeSessionId === "ses_child",
  )!;
  expect(
    [...before.state.messages.values()].find(
      (message) => message.text === "child message",
    )?.agentId,
  ).toBe(childAgent.agentId);
  await child.close();
  captures.pop();
  child = await OpenCodeCapture.open(journal, [], undefined, scope);
  captures.push(child);
  await child.accept(data);
  expect((await replay(journal)).events).toHaveLength(before.events.length);
  data.info.parentID = "foreign_parent";
  await expect(child.accept(data)).rejects.toThrow("selected parent");
});

it("reconciles partial secrets, tools and repeated snapshots across restart without duplicates", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal, ["token_abcdef"]);
  captures.push(capture);
  await capture.accept(snapshot("before token_abc", false, "pending"));
  let result = await replay(journal);
  expect([...result.state.messages.values()][0]?.text).toBe("before ");
  expect([...result.state.tools.values()][0]?.input).toBe("");
  expect(JSON.stringify(result.events)).not.toContain("token_abc");
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal, ["token_abcdef"]);
  captures.push(capture);
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  result = await replay(journal);
  expect([...result.state.messages.values()][0]).toMatchObject({
    text: "before [REDACTED] after",
    completed: true,
  });
  expect([...result.state.tools.values()][0]).toMatchObject({
    status: "completed",
    output: "done [REDACTED]",
  });
  expect(JSON.stringify(result.events)).not.toContain("token_abc");
  const before = journal.capturedThrough;
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  expect(journal.capturedThrough).toBe(before);
  await capture.accept(snapshot("changed", true, "completed"));
  await capture.accept(
    snapshot("before token_abcdef after", true, "completed"),
  );
  expect(journal.capturedThrough).toBeGreaterThan(before);
  expect([...(await replay(journal)).state.messages.values()][0]?.text).toBe(
    "before [REDACTED] after",
  );
  expect(
    await readFile(
      join(journal.directory, "opencode-live", "state.json"),
      "utf8",
    ),
  ).not.toContain("token_abc");
});
it("finishes a staged large revision after a lost journal acknowledgment before accepting a newer snapshot", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const real = journal.capture.bind(journal);
  let calls = 0;
  const spy = vi.spyOn(journal, "capture").mockImplementation(async (input) => {
    const result = await real(input);
    if (++calls === 4) throw new Error("Lost local capture acknowledgment");
    return result;
  });
  try {
    await expect(
      capture.accept(snapshot("long text ".repeat(15000), true)),
    ).rejects.toThrow("Lost local");
  } finally {
    spy.mockRestore();
  }
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  expect((await replay(journal)).state.replacements.size).toBe(0);
  expect([...(await replay(journal)).state.messages.values()][0]?.text).toBe(
    "long text ".repeat(15000),
  );
  await capture.accept(snapshot("newer state", true));
  const result = await replay(journal);
  expect(result.state.messages.size).toBe(1);
  expect([...result.state.messages.values()][0]?.text).toBe("newer state");
  expect(
    result.events.filter((event) => event.content.kind === "message.started"),
  ).toHaveLength(1);
});
it("persists removal and restoration without duplicating objects and refuses changed policy", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("retained", true));
  const empty = parseOpenCodeSnapshot({
    info: { id: "ses_test", time: { created: 1 } },
    messages: [],
  });
  await capture.accept(empty);
  const before = journal.capturedThrough;
  await capture.accept(empty);
  expect(journal.capturedThrough).toBe(before);
  const removed = await replay(journal);
  expect(removed.state.gaps).toHaveLength(0);
  expect([...removed.state.messages.values()][0]).toMatchObject({
    visible: false,
    text: "retained",
  });
  await capture.close();
  captures.pop();
  const restored = await OpenCodeCapture.open(journal);
  captures.push(restored);
  await restored.accept(snapshot("retained", true));
  const result = await replay(journal);
  expect([...result.state.messages.values()][0]).toMatchObject({
    visible: true,
    text: "retained",
  });
  expect(
    result.events.filter((e) => e.content.kind === "message.started"),
  ).toHaveLength(1);
  expect(
    result.events.filter((e) => e.content.kind === "object.visibility"),
  ).toHaveLength(2);
  await restored.close();
  captures.pop();
  await expect(OpenCodeCapture.open(journal, ["changed-key"])).rejects.toThrow(
    "filtering policy changed",
  );
  await rm(join(journal.directory, "opencode-live", "state.json"));
  await expect(OpenCodeCapture.open(journal)).rejects.toThrow(
    "state is missing",
  );
});
it("rejects a reused message identity with a different role before capture", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("assistant", true));
  const before = journal.capturedThrough;
  const changed = snapshot("user", true);
  changed.messages[0]!.info.role = "user";
  await expect(capture.accept(changed)).rejects.toThrow(
    "object identity changed",
  );
  expect(journal.capturedThrough).toBe(before);
});
it("freezes queued native snapshots before the caller mutates their parts", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const input = snapshot("original", true, "completed");
  const pending = capture.accept(input);
  input.messages[0]!.parts[0]!.text = "changed after receipt";
  (input.messages[0]!.parts[1]!.state as { output: string }).output =
    "changed output";
  await pending;
  const result = await replay(journal);
  expect([...result.state.messages.values()][0]?.text).toBe("original");
  expect([...result.state.tools.values()][0]?.output).toBe("done token_abcdef");
});
it("stops between durable entities on cancellation and safely resumes the snapshot", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  const controller = new AbortController();
  const real = journal.capture.bind(journal);
  const spy = vi.spyOn(journal, "capture").mockImplementation(async (input) => {
    const result = await real(input);
    if (input.content[0]?.kind === "message.started") controller.abort();
    return result;
  });
  try {
    await expect(
      capture.accept(
        snapshot("retained", true, "completed"),
        controller.signal,
      ),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect((await replay(journal)).state.messages.size).toBe(1);
  expect((await replay(journal)).state.tools.size).toBe(0);
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("retained", true, "completed"));
  expect((await replay(journal)).state.tools.size).toBe(1);
});
it("captures live attachment versions and reuses announced versions after restart", async () => {
  const { localArtifactResolver } =
    await import("../../packages/adapters/src/index.js");
  const { PublisherNetwork } =
    await import("../../packages/publisher/src/index.js");
  const { startServer } = await import("../../packages/server/src/http.js");
  const { writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "agentlive-live-files-"));
  roots.push(root);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  const journal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: server.url,
    agent: "opencode",
    nativeSessionId: "ses_test",
  });
  journals.push(journal);
  const network = new PublisherNetwork({
    journal,
    ownerCredential: "b".repeat(64),
    title: "Files",
    visibility: "private",
  });
  const controller = new AbortController();
  let capture: OpenCodeCapture | undefined;
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  let sending: Promise<void> | undefined;
  try {
    await network.ensureRemote(controller.signal);
    const file = join(root, "artifact.txt");
    await writeFile(file, "local secret-value");
    const settings = {
      directory: join(journal.directory, "artifacts"),
      roots: [root],
      baseDirectory: root,
      secrets: ["secret-value"],
      serverOrigin: server.url,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal: controller.signal,
    };
    artifacts = await localArtifactResolver(settings);
    capture = await OpenCodeCapture.open(journal, ["secret-value"], artifacts);
    const withFile = (url: string) => {
      const source = snapshot("files", true);
      source.messages[0]!.parts.push({
        id: "file1",
        messageID: "msg1",
        sessionID: "ses_test",
        type: "file",
        filename: "artifact.txt",
        mime: "text/plain",
        url,
      });
      return source;
    };
    const original = pathToFileURL(file).href;
    await capture.accept(withFile(original));
    await capture.accept(
      withFile(
        `data:text/plain;base64,${Buffer.from("inline secret-value").toString("base64")}`,
      ),
    );
    await capture.close();
    capture = undefined;
    await artifacts.close();
    artifacts = undefined;
    const encodingStatePath = join(
      journal.directory,
      "opencode-live",
      "state.json",
    );
    const encodingState = JSON.parse(await readFile(encodingStatePath, "utf8"));
    delete encodingState.attachmentEncodingVersion;
    await writeFile(encodingStatePath, JSON.stringify(encodingState));
    // Simulate the previous flat outcome format before restarting without the source file.
    const { readdir } = await import("node:fs/promises");
    const outcomes = join(settings.directory, "outcomes");
    for (const filename of await readdir(outcomes)) {
      const path = join(outcomes, filename);
      const saved = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify(saved.result));
    }
    await rm(file);
    artifacts = await localArtifactResolver(settings);
    capture = await OpenCodeCapture.open(journal, ["secret-value"], artifacts);
    await capture.accept(withFile(original));
    for (const filename of await readdir(outcomes))
      expect(
        JSON.parse(await readFile(join(outcomes, filename), "utf8")).version,
      ).toBe(1);
    const before = journal.capturedThrough;
    await capture.accept(withFile(original));
    expect(journal.capturedThrough).toBe(before);
    await capture.accept(snapshot("files", true));
    expect(
      [...(await replay(journal)).state.artifacts.values()][0]?.visible,
    ).toBe(false);
    await capture.accept(withFile(original));
    const result = await replay(journal);
    expect([...result.state.artifacts.values()][0]?.visible).toBe(true);
    expect(
      result.events.filter(
        (event) => event.content.kind === "attachment.available",
      ),
    ).toHaveLength(2);
    const artifact = [...result.state.artifacts.values()][0]!;
    expect(artifact.pending).toBe(false);
    expect(artifact.versions.size).toBe(2);
    const local = [...artifact.versions.values()].find(
      (attachment) => attachment.provenance === "current-file",
    )!;
    sending = network.run(controller.signal);
    await expect
      .poll(() => journal.identity.acknowledgedSeq, { timeout: 10000 })
      .toBe(journal.capturedThrough);
    const response = await fetch(
      `${server.url}/api/v1/streams/${journal.identity.streamId}/attachments/${local.hash}`,
      { headers: { authorization: `Bearer ${journal.identity.writeSecret}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("local [REDACTED]");
  } finally {
    controller.abort();
    await sending;
    await capture?.close();
    await artifacts?.close();
    await server.close();
  }
}, 20000);
it("reopens completed messages and tools without duplicating their identities", async () => {
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("first completion", true, "completed"));
  const first = (await replay(journal)).state;
  await capture.close();
  captures.pop();
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("continued partial", false, "running"));
  let result = await replay(journal);
  expect([...first.messages.values()][0]?.completed).toBe(true);
  expect([...first.tools.values()][0]?.output).toBe("done token_abcdef");
  expect([...result.state.messages.values()][0]).toMatchObject({
    completed: false,
    text: "continued partial",
  });
  expect([...result.state.tools.values()][0]).toMatchObject({
    status: "running",
    output: "",
  });
  expect(result.state.gaps).toHaveLength(0);
  const before = journal.capturedThrough;
  await capture.accept(snapshot("continued partial", false, "running"));
  expect(journal.capturedThrough).toBe(before);
  await capture.accept(snapshot("second completion", true, "completed"));
  result = await replay(journal);
  expect(result.state.messages.size).toBe(1);
  expect(result.state.tools.size).toBe(1);
  expect(
    result.events.filter((event) => event.content.kind === "message.reopened"),
  ).toHaveLength(1);
  expect(
    result.events.filter((event) => event.content.kind === "tool.reopened"),
  ).toHaveLength(1);
  expect([...result.state.messages.values()][0]?.completed).toBe(true);
});
it("upgrades a legacy checkpoint whose gap left replay completion stale", async () => {
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("finished", true));
  await capture.close();
  captures.pop();
  const id = digest("msg1");
  const statePath = join(journal.directory, "opencode-live", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.lifecycleVersion;
  state.entities[id].completed = false;
  // Match the next source fingerprint to prove lifecycle repair does not depend on text changing.
  const { canonicalJson } =
    await import("../../packages/protocol/src/index.js");
  state.entities[id].fingerprint = createHash("sha256")
    .update(
      canonicalJson({ role: "assistant", text: "finished", complete: false }),
    )
    .digest("hex");
  await writeFile(statePath, JSON.stringify(state));
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("finished", false));
  const result = await replay(journal);
  expect([...result.state.messages.values()][0]?.completed).toBe(false);
  expect(
    result.events.filter((event) => event.content.kind === "message.reopened"),
  ).toHaveLength(1);
});

it("repairs legacy removal checkpoints from the durable event history", async () => {
  const { writeFile } = await import("node:fs/promises");
  const journal = await setup();
  let capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(snapshot("retained", true, "completed"));
  await capture.close();
  captures.pop();
  const path = join(journal.directory, "opencode-live", "state.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  delete checkpoint.presentationVersion;
  for (const entity of Object.values(checkpoint.entities) as {
    present: boolean;
    objectType?: string;
  }[]) {
    entity.present = false;
    delete entity.objectType;
  }
  await writeFile(path, JSON.stringify(checkpoint));
  capture = await OpenCodeCapture.open(journal);
  captures.push(capture);
  await capture.accept(
    parseOpenCodeSnapshot({
      info: { id: "ses_test", time: { created: 1 } },
      messages: [],
    }),
  );
  let result = await replay(journal);
  expect([...result.state.messages.values()][0]?.visible).toBe(false);
  expect([...result.state.tools.values()][0]?.visible).toBe(false);
  await capture.accept(snapshot("retained", true, "completed"));
  result = await replay(journal);
  expect([...result.state.messages.values()][0]?.visible).toBe(true);
  expect([...result.state.tools.values()][0]?.visible).toBe(true);
  expect(result.state.tools.size).toBe(1);
  expect(result.state.gaps).toHaveLength(0);
});

it("upgrades unavailable attachment checkpoints without rewriting history and resumes migration after restart", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const journal = await setup();
  const source = snapshot("retained", true);
  source.messages[0]!.parts.push({
    id: "inline-upgrade",
    sessionID: "ses_test",
    messageID: "msg1",
    type: "file",
    mime: "text/plain",
    filename: "note.txt",
    url: "data:text/plain;charset=utf-8,now%20available",
  });
  let capture = await OpenCodeCapture.open(journal, []);
  captures.push(capture);
  await capture.accept(source);
  const before = (await replay(journal)).events;
  expect(
    before.some((event) => event.content.kind === "attachment.unavailable"),
  ).toBe(true);
  await capture.close();
  const path = join(journal.directory, "opencode-live", "state.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.attachmentEncodingVersion;
  await writeFile(path, JSON.stringify(legacy));
  const resolveInline = vi.fn(async (input) => ({
    artifactId: input.artifactId,
    version: 1,
    hash: createHash("sha256").update(input.bytes).digest("hex"),
    filename: input.filename,
    mediaType: input.mediaType,
    byteSize: input.bytes.length,
  }));
  const resolvers = {
    resolveInline,
    resolveArtifact: async () => ({ reason: "not a local file" }),
  };
  capture = await OpenCodeCapture.open(journal, [], resolvers);
  captures.push(capture);
  // Restart after the migration checkpoint commits but before any native snapshot arrives.
  await capture.close();
  capture = await OpenCodeCapture.open(journal, [], resolvers);
  captures.push(capture);
  await capture.accept(source);
  const result = await replay(journal);
  expect(result.events.slice(0, before.length)).toEqual(before);
  expect(resolveInline).toHaveBeenCalledTimes(1);
  expect(
    result.events.filter(
      (event) => event.content.kind === "attachment.available",
    ),
  ).toHaveLength(1);
  expect(result.state.messages.size).toBe(1);
  const boundary = journal.capturedThrough;
  await capture.close();
  capture = await OpenCodeCapture.open(journal, [], resolvers);
  captures.push(capture);
  await capture.accept(source);
  expect(journal.capturedThrough).toBe(boundary);
  expect(resolveInline).toHaveBeenCalledTimes(1);
});

it("retains a possible secret prefix in an active error and releases it only at native completion", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal, ["danger-secret"]);
  captures.push(capture);
  const active = snapshot("Starting");
  active.messages[0]!.info.error = {
    name: "APIError",
    data: { message: "credits exhausted" },
  };
  await capture.accept(active);
  expect([...(await replay(journal)).state.messages.values()][0]).toMatchObject(
    { text: "Starting\ncredits exhauste", completed: false },
  );
  active.messages[0]!.info.time.completed = 2;
  await capture.accept(active);
  expect([...(await replay(journal)).state.messages.values()][0]).toMatchObject(
    { text: "Starting\ncredits exhausted", completed: true },
  );
});

it("applies native revert boundaries and restores hidden messages on unrevert", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal, []);
  captures.push(capture);
  const original = snapshot("Retained text", true, "completed");
  await capture.accept(original);
  const reverted = structuredClone(original);
  reverted.info.revert = {
    messageID: "msg1",
    snapshot: "native-snapshot",
    diff: "not copied",
  };
  await capture.accept(reverted);
  let result = await replay(journal);
  expect([...result.state.messages.values()][0]?.visible).toBe(false);
  expect([...result.state.tools.values()][0]?.visible).toBe(false);
  const through = journal.capturedThrough;
  await capture.accept(reverted);
  expect(journal.capturedThrough).toBe(through);
  await capture.close();
  captures.pop();
  const reopened = await OpenCodeCapture.open(journal, []);
  captures.push(reopened);
  await reopened.accept(reverted);
  expect(journal.capturedThrough).toBe(through);
  await reopened.accept(original);
  result = await replay(journal);
  expect([...result.state.messages.values()][0]?.visible).toBe(true);
  expect([...result.state.tools.values()][0]?.visible).toBe(true);
});

it("captures only the retained part prefix from an initially reverted snapshot and rejects unknown boundaries", async () => {
  const journal = await setup();
  const capture = await OpenCodeCapture.open(journal, []);
  captures.push(capture);
  const input = snapshot("Kept prefix", true, "completed");
  input.info.revert = { messageID: "msg1", partID: "tool1" };
  await capture.accept(input);
  const result = await replay(journal);
  expect(result.state.messages.size).toBe(1);
  expect(result.state.tools.size).toBe(0);
  expect(input.messages[0]!.parts).toHaveLength(2);
  const before = journal.capturedThrough;
  const malformed = structuredClone(input);
  malformed.info.revert = { messageID: "msg1", partID: "missing" };
  expect(() => capture.accept(malformed)).toThrow("revert part");
  malformed.info.revert = { messageID: "missing" };
  expect(() => capture.accept(malformed)).toThrow("revert message");
  expect(journal.capturedThrough).toBe(before);
});

it("keeps capturing family lineage after the journal prunes its acknowledged prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-retention-"));
  roots.push(root);
  const journal = await PublisherJournal.open(
    root,
    {
      serverOrigin: "http://localhost",
      agent: "opencode",
      nativeSessionId: "ses_test",
    },
    // Small enough that a handful of revisions seals and prunes segments.
    { retention: { segmentBytes: 1024, retainAcknowledgedBytes: 0 } },
  );
  journals.push(journal);
  await journal.bindRemote("stream1", "revision1");
  const parent = await OpenCodeCapture.open(journal);
  captures.push(parent);
  for (let n = 0; n < 12; n++)
    await parent.accept(snapshot(`parent text ${n}`.padEnd(400, "p")));
  await parent.accept(snapshot("parent final", true, "completed"));

  const childSnapshot = (id: string) => {
    const data = snapshot(`${id} message`, true, "completed");
    data.info.id = id;
    data.info.parentID = "ses_test";
    for (const message of data.messages) {
      message.info.sessionID = id;
      for (const part of message.parts) part.sessionID = id;
    }
    return data;
  };
  // The first child publishes the parent's lineage as well as its own.
  const first = await OpenCodeCapture.open(journal, [], undefined, {
    nativeSessionId: "ses_child_one",
    parentNativeSessionId: "ses_test",
  });
  captures.push(first);
  await first.accept(childSnapshot("ses_child_one"));

  // Acknowledge everything so the whole prefix, lineage included, is pruned.
  await journal.acknowledge(journal.capturedThrough);
  expect(journal.compactedThrough).toBeGreaterThan(0);
  await expect(async () => {
    for await (const _ of journal.pending(0)) void _;
  }).rejects.toMatchObject({ code: "cursor_invalid" });
  const pruned = journal.capturedThrough;

  // A second child opened now must still know the parent's lineage was captured,
  // and publish only its own half rather than a second placeholder.
  const second = await OpenCodeCapture.open(journal, [], undefined, {
    nativeSessionId: "ses_child_two",
    parentNativeSessionId: "ses_test",
  });
  captures.push(second);
  await second.accept(childSnapshot("ses_child_two"));
  expect(journal.capturedThrough).toBeGreaterThan(pruned);
  const events = [];
  for await (const event of journal.pending(pruned)) events.push(event);
  expect(
    events.filter((event) => event.content.kind === "agent.updated"),
  ).toHaveLength(1);
  // Repeating the snapshot adds nothing, so the durable state is what dedups.
  const after = journal.capturedThrough;
  await second.accept(childSnapshot("ses_child_two"));
  expect(journal.capturedThrough).toBe(after);
});
