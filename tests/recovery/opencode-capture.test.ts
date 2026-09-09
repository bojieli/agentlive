import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeCapture,
  parseOpenCodeSnapshot,
} from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
const roots: string[] = [];
const journals: PublisherJournal[] = [];
const captures: OpenCodeCapture[] = [];
afterEach(async () => {
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
      timelineMs: event.elapsedMs,
      content: event.content,
      origin: { type: "server", operationId: `test${event.producerSeq}` },
    });
  }
  return { state, events };
}
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
