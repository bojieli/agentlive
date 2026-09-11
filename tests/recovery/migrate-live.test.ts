import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { migrateLiveBinding } from "../../packages/cli/src/migrate-live.js";

const exec = promisify(execFile),
  cli = resolve("packages/cli/dist/main.js");
const credential = "b".repeat(64);
const SECRET = "live-migration-secret-4711";
const baseEnv = {
  PATH: process.env.PATH ?? "",
  AGENTLIVE_OWNER_SECRET: credential,
};
// The changed filter: this value is now redacted automatically (name contains TOKEN).
const newEnv = { ...baseEnv, LIVE_MIGRATION_TOKEN: SECRET };
const newSecrets = [credential, SECRET, credential];
type Agent = "claude" | "codex" | "kimi";

function fixture(agent: Agent, root: string) {
  const native = join(root, "native");
  const source =
    agent === "kimi"
      ? join(native, "session_livemig", "agents", "main", "wire.jsonl")
      : join(native, "livemig.jsonl");
  const header =
    agent === "codex"
      ? JSON.stringify({
          type: "session_meta",
          timestamp: "2026-09-01T00:00:00Z",
          payload: {
            id: "livemig",
            session_id: "livemig",
            timestamp: "2026-09-01T00:00:00Z",
            cli_version: "test",
          },
        }) + "\n"
      : agent === "kimi"
        ? JSON.stringify({
            type: "metadata",
            protocol_version: "1.5",
            created_at: 1,
          }) + "\n"
        : "";
  const row = (id: string, text: string) =>
    JSON.stringify(
      agent === "codex"
        ? {
            type: "event_msg",
            timestamp: "2026-09-01T00:00:01Z",
            payload: {
              type: "item_completed",
              item: {
                id,
                type: "AgentMessage",
                content: [{ type: "Text", text }],
              },
            },
          }
        : agent === "kimi"
          ? {
              type: "context.append_message",
              time: 2,
              message: { role: "user", content: [{ type: "text", text }] },
            }
          : {
              type: "user",
              sessionId: "livemig",
              uuid: id,
              timestamp: "2026-09-01T00:00:01Z",
              message: { content: text },
            },
    ) + "\n";
  return { native, source, header, row };
}

async function publishUntil(
  args: string[],
  env: Record<string, string>,
  whileAttached?: (events: Record<string, unknown>[]) => Promise<void>,
) {
  const child = spawn(process.execPath, [cli, "publish", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  const events: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout! });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "publish did not become live: " + stderr + JSON.stringify(events),
            ),
          ),
        20000,
      );
      let caughtUp = false,
        live = false;
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "source-caught-up") caughtUp = true;
        if (event.event === "publisher-status") live = event.status === "live";
        if (caughtUp && live) {
          clearTimeout(timer);
          done();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("publish exited: " + stderr));
      });
    });
    await whileAttached?.(events);
  } finally {
    child.kill("SIGINT");
    await exited;
    lines.close();
  }
  return events;
}

/** Detached publishers keep unacknowledged events; reattach until all are delivered. */
async function settle(
  state: string[],
  args: string[],
  env: Record<string, string>,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const [binding] = (await run(["status", ...state], env)).bindings;
    if (binding.pendingEvents === 0) return;
    await publishUntil(
      args,
      env,
      () => new Promise((done) => setTimeout(done, 300)),
    );
  }
  throw new Error("Publisher did not deliver its captured events");
}

const run = async (args: string[], env: Record<string, string> = newEnv) => {
  const result = await exec(process.execPath, [cli, ...args], {
    env,
    timeout: 40000,
  });
  return JSON.parse(result.stdout);
};
const fails = (args: string[], message: string, env = newEnv) =>
  expect(
    exec(process.execPath, [cli, ...args], { env, timeout: 40000 }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });

type Server = Awaited<ReturnType<typeof startServer>>;
async function history(server: Server, streamId: string) {
  const session = await server.store.get(streamId);
  const events = [];
  try {
    for await (const event of session.history(0, session.boundary.sequence))
      events.push(event);
    return { info: session.info, events };
  } finally {
    server.store.release(session);
  }
}
const contents = (events: { origin: { type: string }; content: unknown }[]) =>
  events
    .filter((event) => event.origin.type === "publisher")
    .map((event) => event.content);

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((done) => setTimeout(done, 50));
  }
}

async function snapshotFiles(directory: string) {
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    if (name === ".publisher.lock") continue;
    const info = await stat(join(directory, name));
    if (info.isFile())
      result[name] = (await readFile(join(directory, name))).toString("base64");
  }
  return result;
}

/** Import exactly the frozen prefix into an unrelated state directory for comparison. */
async function freshImport(
  agent: Agent,
  root: string,
  source: string,
  bytes: number,
  title: string,
  server: Server,
) {
  const copy = join(root, "fresh", relative(join(root, "native"), source));
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, (await readFile(source)).subarray(0, bytes));
  const result = await run([
    "import",
    "--agent",
    agent,
    "--source",
    copy,
    "--server",
    server.url,
    "--state-dir",
    join(root, "fresh-state"),
    "--title",
    title,
    "--artifact-base",
    dirname(source),
  ]);
  return contents((await history(server, result.streamId)).events);
}

async function setup(agent: Agent) {
  const root = await mkdtemp(
    join(tmpdir(), `agentlive-live-migrate-${agent}-`),
  );
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: credential,
    port: 0,
  });
  const native = fixture(agent, root);
  await mkdir(dirname(native.source), { recursive: true });
  await writeFile(
    native.source,
    native.header + native.row("first", `first ${SECRET} visible`),
  );
  const state = ["--state-dir", root];
  const publishArgs = [
    "--agent",
    agent,
    "--source",
    native.source,
    "--server",
    server.url,
    ...state,
  ];
  // The original live binding: public, default title, no extra filter.
  const first = await publishUntil(
    [...publishArgs, "--visibility", "public"],
    baseEnv,
  );
  const sourceStreamId = first.find((event) => event.event === "publishing")!
    .streamId as string;
  await settle(state, [...publishArgs, "--visibility", "public"], baseEnv);
  const status = await run(["status", ...state]);
  expect(status.bindings).toHaveLength(1);
  const bindingDirectory = status.bindings[0].bindingDirectory as string;
  const inspection = await run([
    "inspect-migration",
    "--source",
    bindingDirectory,
  ]);
  expect(inspection.mode).toBe("live");
  return {
    root,
    server,
    native,
    state,
    publishArgs,
    oldArgs: [...publishArgs, "--visibility", "public"],
    sourceStreamId,
    bindingDirectory,
    manifestHash: inspection.published.manifestHash as string,
  };
}

it("replaces a live Claude binding under a changed filter and title, resuming after interruption", async () => {
  const s = await setup("claude");
  const { server, native, state, root } = s;
  try {
    const attachedArgs = [
      "migrate-live",
      "--stream",
      s.sourceStreamId,
      "--native-source",
      native.source,
      "--operation-id",
      "live-one",
      "--expected-manifest-hash",
      s.manifestHash,
      "--old-recording",
      "retain",
      ...state,
    ];
    await publishUntil(s.oldArgs, baseEnv, async () => {
      await fails(attachedArgs, "publisher process is attached");
    });
    // Captured by nobody yet: the frozen prefix extends past the old live cursor,
    // and an incomplete trailing line stays outside it.
    const second = native.row("second", `second ${SECRET} frozen`);
    await appendFile(native.source, second);
    const complete = await readFile(native.source);
    const partial = native.row("third", "third arrives live");
    await appendFile(native.source, partial.slice(0, 20));
    const title = "Replacement title";
    const args = [
      "migrate-live",
      "--stream",
      s.sourceStreamId,
      "--native-source",
      native.source,
      "--operation-id",
      "live-one",
      "--expected-manifest-hash",
      s.manifestHash,
      "--old-recording",
      "retain",
      "--title",
      title,
      ...state,
    ];
    const before = await snapshotFiles(s.bindingDirectory);
    const oldBefore = await history(server, s.sourceStreamId);
    expect(oldBefore.info.lifecycle).toBe("open");

    // Rejections leave the binding untouched and persist no intent.
    const wrong = args.map((value) =>
      value === s.manifestHash ? "0".repeat(64) : value,
    );
    await fails(wrong, "manifest changed since inspection");
    await fails(
      args.map((value) => (value === "retain" ? "remove" : value)),
      "requires --confirm-removal",
    );
    expect(await snapshotFiles(s.bindingDirectory)).toEqual(before);
    const intentPath = join(
      root,
      "publisher",
      "live-migrations",
      s.bindingDirectory.split("/").pop()!,
      "intent.json",
    );
    await expect(readFile(intentPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Process death right after the durable intent.
    await expect(
      migrateLiveBinding({
        directory: s.bindingDirectory,
        nativeSource: native.source,
        operationId: "live-one",
        expectedManifestHash: s.manifestHash,
        disposition: "retain",
        sourceStreamId: s.sourceStreamId,
        ownerCredential: credential,
        secrets: newSecrets,
        title,
        signal: AbortSignal.timeout(20000),
        onPhase: (phase) => {
          if (phase === "intent") throw new Error("died after intent");
        },
      }),
    ).rejects.toThrow("died after intent");
    const intent = JSON.parse(await readFile(intentPath, "utf8"));
    expect(intent).toMatchObject({
      operationId: "live-one",
      completed: false,
      boundary: { root: { offset: complete.length }, children: [] },
    });
    expect(JSON.stringify(intent)).not.toContain(SECRET);
    // The pending intent fences publishing and competing operations.
    await fails(
      ["publish", ...s.publishArgs],
      "live-binding migration is pending",
      baseEnv,
    );
    await fails(
      args.map((value) => (value === "live-one" ? "live-two" : value)),
      "Live migration live-one is pending",
    );
    await fails(
      args.map((value) => (value === title ? "Other title" : value)),
      "policy changed during retry",
    );
    expect((await history(server, s.sourceStreamId)).info.lifecycle).toBe(
      "open",
    );

    const receipt = await run(args);
    expect(receipt).toMatchObject({
      event: "live-migrated",
      operationId: "live-one",
      sourceStreamId: s.sourceStreamId,
      disposition: "retain",
      visibility: "private",
      frozenBoundary: { sourceBytes: complete.length, familySources: 0 },
      bindingDirectory: s.bindingDirectory,
      continuation: {
        agent: "claude",
        title,
        visibility: "private",
        resumeImport: true,
      },
      completed: true,
    });
    const targetId = receipt.target.streamId as string;
    expect(targetId).not.toBe(s.sourceStreamId);
    expect(await run(args)).toEqual(receipt);

    const target = await history(server, targetId);
    expect(target.info).toMatchObject({
      title,
      visibility: "private",
      lifecycle: "ended",
      migrationOrigin: {
        operationId: "live-one",
        sourceStreamId: s.sourceStreamId,
        requestedSourceDisposition: "retain",
      },
    });
    const text = JSON.stringify(target.events);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("second ");
    expect(text).not.toContain("third arrives");
    expect(contents(target.events)).toEqual(
      await freshImport(
        "claude",
        root,
        native.source,
        complete.length,
        title,
        server,
      ),
    );
    // The old recording is retained, ended, and received no replacement content.
    const oldAfter = await history(server, s.sourceStreamId);
    expect(oldAfter.info.lifecycle).toBe("ended");
    expect(oldAfter.info.visibility).toBe("public");
    expect(oldAfter.events.slice(0, oldBefore.events.length)).toEqual(
      oldBefore.events,
    );
    expect(oldAfter.events.slice(oldBefore.events.length)).toMatchObject([
      { content: { kind: "recording.ended" } },
    ]);
    const status = await run(["status", ...state]);
    expect(status.bindings).toEqual([
      expect.objectContaining({
        bindingDirectory: s.bindingDirectory,
        streamId: targetId,
        mode: "import",
      }),
    ]);
    const retired = JSON.parse(
      await readFile(join(receipt.retiredDirectory, "binding.json"), "utf8"),
    );
    expect(retired.streamId).toBe(s.sourceStreamId);

    // Continuing with the old options is rejected; the new options continue live.
    await fails(
      ["publish", ...s.oldArgs, "--resume-import"],
      "options differ",
      baseEnv,
    );
    await appendFile(native.source, partial.slice(20));
    await appendFile(native.source, native.row("fourth", `fourth ${SECRET}`));
    await publishUntil(
      [...s.publishArgs, "--resume-import", "--title", title],
      newEnv,
      () =>
        waitFor(async () => {
          const events = JSON.stringify(
            (await history(server, targetId)).events,
          );
          return (
            events.includes("third arrives live") && events.includes("fourth ")
          );
        }, "live continuation"),
    );
    const continued = await history(server, targetId);
    expect(continued.info.lifecycle).toBe("open");
    expect(continued.events.slice(0, target.events.length)).toEqual(
      target.events,
    );
    expect(JSON.stringify(continued.events)).not.toContain(SECRET);
    expect((await history(server, s.sourceStreamId)).events).toEqual(
      oldAfter.events,
    );
    // A finished operation remains a no-op; a new operation may migrate the successor.
    expect(await run(args)).toEqual(receipt);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it("replaces a live Codex binding, removing the old recording after lost responses", async () => {
  const s = await setup("codex");
  const { server, native, state, root } = s;
  try {
    await appendFile(native.source, native.row("second", `second ${SECRET}`));
    const complete = await readFile(native.source);
    const options = {
      directory: s.bindingDirectory,
      nativeSource: native.source,
      operationId: "codex-live",
      expectedManifestHash: s.manifestHash,
      disposition: "remove" as const,
      confirmRemoval: true,
      ownerCredential: credential,
      secrets: newSecrets,
      signal: AbortSignal.timeout(20000),
    };
    // Death after the replacement import, then after lineage but before retirement.
    for (const failure of ["imported", "lineage"] as const)
      await expect(
        migrateLiveBinding({
          ...options,
          onPhase: (phase) => {
            if (phase === failure) throw new Error(`died after ${failure}`);
          },
        }),
      ).rejects.toThrow(`died after ${failure}`);
    const source = await history(server, s.sourceStreamId);
    expect(source.info.lifecycle).toBe("ended");
    const receipt = await run([
      "migrate-live",
      "--source",
      s.bindingDirectory,
      "--native-source",
      native.source,
      "--operation-id",
      "codex-live",
      "--expected-manifest-hash",
      s.manifestHash,
      "--old-recording",
      "remove",
      "--confirm-removal",
      ...state,
    ]);
    expect(receipt).toMatchObject({
      disposition: "remove",
      frozenBoundary: { sourceBytes: complete.length },
      continuation: { agent: "codex", recordFormat: "structured" },
    });
    const targetId = receipt.target.streamId as string;
    const removed = await fetch(
      `${server.url}/api/v1/streams/${s.sourceStreamId}`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    expect(removed.ok).toBe(false);
    const target = await history(server, targetId);
    expect(target.info.migrationOrigin).toMatchObject({
      operationId: "codex-live",
      requestedSourceDisposition: "remove",
    });
    expect(JSON.stringify(target.events)).not.toContain(SECRET);
    expect(contents(target.events)).toEqual(
      await freshImport(
        "codex",
        root,
        native.source,
        complete.length,
        "Live codex session",
        server,
      ),
    );
    await appendFile(native.source, native.row("third", "third codex live"));
    await publishUntil(
      [
        ...s.publishArgs,
        "--resume-import",
        "--title",
        receipt.continuation.title,
      ],
      newEnv,
      () =>
        waitFor(
          async () =>
            JSON.stringify((await history(server, targetId)).events).includes(
              "third codex live",
            ),
          "codex continuation",
        ),
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it("resumes a Kimi live migration interrupted between retirement and placement", async () => {
  const s = await setup("kimi");
  const { server, native, state, root } = s;
  try {
    await appendFile(native.source, native.row("second", `second ${SECRET}`));
    await expect(
      migrateLiveBinding({
        directory: s.bindingDirectory,
        nativeSource: native.source,
        operationId: "kimi-live",
        expectedManifestHash: s.manifestHash,
        disposition: "retain",
        ownerCredential: credential,
        secrets: newSecrets,
        signal: AbortSignal.timeout(20000),
        onPhase: (phase) => {
          if (phase === "retired") throw new Error("died after retire");
        },
      }),
    ).rejects.toThrow("died after retire");
    await expect(stat(s.bindingDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // No second target may be created at the vacated key.
    await fails(
      ["publish", ...s.publishArgs],
      "live-binding migration is pending",
      newEnv,
    );
    await expect(stat(s.bindingDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const args = [
      "migrate-live",
      "--stream",
      s.sourceStreamId,
      "--native-source",
      native.source,
      "--operation-id",
      "kimi-live",
      "--expected-manifest-hash",
      s.manifestHash,
      "--old-recording",
      "retain",
      ...state,
    ];
    const receipt = await run(args);
    expect(receipt.completed).toBe(true);
    expect(await run(args)).toEqual(receipt);
    const targetId = receipt.target.streamId as string;
    const target = await history(server, targetId);
    expect(JSON.stringify(target.events)).not.toContain(SECRET);
    expect(JSON.stringify(target.events)).toContain("second ");
    expect((await history(server, s.sourceStreamId)).info.lifecycle).toBe(
      "ended",
    );
    await appendFile(native.source, native.row("third", "third kimi live"));
    await publishUntil(
      [
        ...s.publishArgs,
        "--resume-import",
        "--title",
        receipt.continuation.title,
      ],
      newEnv,
      () =>
        waitFor(
          async () =>
            JSON.stringify((await history(server, targetId)).events).includes(
              "third kimi live",
            ),
          "kimi continuation",
        ),
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it("rejects undelivered events and OpenCode bindings without changing them", async () => {
  const s = await setup("claude");
  const { server, native, state, root } = s;
  try {
    const journal = await PublisherJournal.openExisting(s.bindingDirectory);
    try {
      await journal.capture({
        sourceKey: "undelivered",
        observedAt: "2026-09-01T00:00:02Z",
        clockSegmentId: "clock",
        elapsedMs: 5,
        fidelity: "delta",
        adapterState: journal.checkpoint,
        content: [
          {
            kind: "message.started",
            payload: { messageId: "pending", role: "assistant" },
          },
        ],
      });
    } finally {
      await journal.close();
    }
    const before = await snapshotFiles(s.bindingDirectory);
    const args = [
      "migrate-live",
      "--source",
      s.bindingDirectory,
      "--native-source",
      native.source,
      "--operation-id",
      "pending-one",
      "--expected-manifest-hash",
      s.manifestHash,
      "--old-recording",
      "retain",
      ...state,
    ];
    await fails(args, "undelivered events");
    expect(await snapshotFiles(s.bindingDirectory)).toEqual(before);

    const opencode = await PublisherJournal.open(join(root, "publisher"), {
      serverOrigin: server.url,
      agent: "opencode",
      nativeSessionId: "opencode_session",
    });
    const directory = opencode.directory;
    await opencode.close();
    await fails(
      args.map((value) => (value === s.bindingDirectory ? directory : value)),
      "does not support OpenCode",
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("freezes Claude family children at complete lines and continues them live", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-live-migrate-family-"));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: credential,
    port: 0,
  });
  try {
    const native = fixture("claude", root);
    const childPath = join(
      native.native,
      "livemig",
      "subagents",
      "agent-worker.jsonl",
    );
    const childRow = (id: string, text: string) =>
      JSON.stringify({
        type: "user",
        sessionId: "livemig",
        uuid: id,
        agentId: "worker",
        isSidechain: true,
        timestamp: "2026-09-01T00:00:02Z",
        message: { content: text },
      }) + "\n";
    await mkdir(dirname(childPath), { recursive: true });
    await writeFile(native.source, native.row("main-1", "main first"));
    await writeFile(childPath, childRow("child-1", `child ${SECRET} one`));
    const state = ["--state-dir", root];
    const publishArgs = [
      "--agent",
      "claude",
      "--source",
      native.source,
      "--include-children",
      "--server",
      server.url,
      ...state,
    ];
    const first = await publishUntil(publishArgs, baseEnv, (events) =>
      waitFor(async () => {
        const publishing = events.find((event) => event.event === "publishing");
        return (
          publishing !== undefined &&
          JSON.stringify(
            (await history(server, publishing.streamId as string)).events,
          ).includes("child ")
        );
      }, "child capture"),
    );
    const sourceStreamId = first.find((event) => event.event === "publishing")!
      .streamId as string;
    await settle(state, publishArgs, baseEnv);
    const oldEvents = JSON.stringify(
      (await history(server, sourceStreamId)).events,
    );
    expect(oldEvents).toContain("child ");
    const binding = (await run(["status", ...state])).bindings[0];
    const inspection = await run([
      "inspect-migration",
      "--source",
      binding.bindingDirectory,
    ]);
    await appendFile(native.source, native.row("main-2", "main second"));
    await appendFile(childPath, childRow("child-2", `child ${SECRET} two`));
    const childComplete = await readFile(childPath);
    const partial = childRow("child-3", "child three live");
    await appendFile(childPath, partial.slice(0, 15));
    const receipt = await run([
      "migrate-live",
      "--stream",
      sourceStreamId,
      "--native-source",
      native.source,
      "--operation-id",
      "family-live",
      "--expected-manifest-hash",
      inspection.published.manifestHash,
      "--old-recording",
      "retain",
      ...state,
    ]);
    expect(receipt).toMatchObject({
      targetConverterVersion: "claude-history-4-family-import-1",
      frozenBoundary: { familySources: 1 },
      continuation: { includeChildren: true },
    });
    const targetId = receipt.target.streamId as string;
    const target = await history(server, targetId);
    const text = JSON.stringify(target.events);
    expect(text).toContain("child ");
    expect(text).toContain("main second");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("child three");
    // Fresh family import of the same frozen prefixes under the new policy.
    const freshRoot = join(root, "fresh");
    const freshMain = join(freshRoot, "livemig.jsonl");
    const freshChild = join(
      freshRoot,
      "livemig",
      "subagents",
      "agent-worker.jsonl",
    );
    await mkdir(dirname(freshChild), { recursive: true });
    await writeFile(
      freshMain,
      (await readFile(native.source)).subarray(
        0,
        receipt.frozenBoundary.sourceBytes,
      ),
    );
    await writeFile(freshChild, childComplete);
    const fresh = await run([
      "import",
      "--agent",
      "claude",
      "--source",
      freshMain,
      "--include-children",
      "--server",
      server.url,
      "--state-dir",
      join(root, "fresh-state"),
      "--title",
      receipt.continuation.title,
      "--artifact-base",
      dirname(native.source),
    ]);
    expect(contents(target.events)).toEqual(
      contents((await history(server, fresh.streamId)).events),
    );
    await appendFile(childPath, partial.slice(15));
    await publishUntil(
      [
        ...publishArgs,
        "--resume-import",
        "--title",
        receipt.continuation.title,
      ],
      newEnv,
      () =>
        waitFor(
          async () =>
            JSON.stringify((await history(server, targetId)).events).includes(
              "child three live",
            ),
          "child continuation",
        ),
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
