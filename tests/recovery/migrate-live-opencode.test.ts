import { afterEach, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createServer, type ServerResponse } from "node:http";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import {
  abandonLiveMigration,
  migrateLiveBinding,
} from "../../packages/cli/src/migrate-live.js";

const exec = promisify(execFile),
  cli = resolve("packages/cli/dist/main.js");
const credential = "b".repeat(64);
const SECRET = "opencode-live-migration-secret-4711";
const baseEnv = {
  PATH: process.env.PATH ?? "",
  AGENTLIVE_OWNER_SECRET: credential,
};
// The changed filter: this value is now redacted automatically (name contains TOKEN).
const newEnv = { ...baseEnv, LIVE_MIGRATION_TOKEN: SECRET };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A minimal OpenCode server: one root session, one child, mutable message text. */
async function nativeServer() {
  let text = `root ${SECRET} one`;
  let childText = `child ${SECRET} one`;
  let created = 1;
  let dropped = false;
  const clients = new Set<ServerResponse>();
  const info = (id: string, parent?: string) => ({
    id,
    ...(parent ? { parentID: parent } : {}),
    time: { created, updated: 2 },
  });
  const messages = (id: string, value: string) => [
    {
      info: {
        id: `msg_${id}`,
        sessionID: id,
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: `part_${id}`,
          sessionID: id,
          messageID: `msg_${id}`,
          type: "text",
          text: value,
        },
        {
          id: `file_${id}`,
          sessionID: id,
          messageID: `msg_${id}`,
          type: "file",
          mime: "text/plain",
          filename: `${id}.txt`,
          url:
            "data:text/plain;base64," +
            Buffer.from(`bytes ${value}`).toString("base64"),
        },
      ],
    },
  ];
  const server = createServer((request, response) => {
    if (request.url === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"server.connected"}\n\n');
      clients.add(response);
      response.on("close", () => clients.delete(response));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/session/ses_test/children")
      response.end(JSON.stringify([info("ses_child", "ses_test")]));
    else if (request.url === "/session/ses_child/children") response.end("[]");
    else if (request.url === "/session/ses_test")
      response.end(JSON.stringify(info("ses_test")));
    else if (request.url === "/session/ses_child")
      response.end(JSON.stringify(info("ses_child", "ses_test")));
    else if (request.url === "/session/ses_test/message")
      response.end(dropped ? "[]" : JSON.stringify(messages("ses_test", text)));
    else if (request.url === "/session/ses_child/message")
      response.end(JSON.stringify(messages("ses_child", childText)));
    else response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const stop = async () => {
    for (const response of clients) response.destroy();
    if (server.listening)
      await new Promise<void>((done) => server.close(() => done()));
  };
  cleanup.push(stop);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stop,
    /** Forget the session's messages, as a native revert or purge would. */
    dropMessages: (value: boolean) => {
      dropped = value;
    },
    /** Recreate the native session under the same identity. */
    recreate: (value: number) => {
      created = value;
    },
    update: (root: string, child: string) => {
      text = root;
      childText = child;
      for (const response of clients)
        response.write('data: {"type":"message.updated"}\n\n');
    },
  };
}

/** Run `publish` until it is live and has captured, then stop it. */
async function publishUntil(
  args: string[],
  env: Record<string, string>,
  whileAttached?: () => Promise<void>,
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
        45000,
      );
      let observing = false,
        live = false;
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "native-status" && event.status === "observing")
          observing = true;
        if (event.event === "publisher-status") live = event.status === "live";
        if (observing && live) {
          clearTimeout(timer);
          done();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("publish exited: " + stderr));
      });
    });
    await whileAttached?.();
  } finally {
    child.kill("SIGINT");
    await exited;
    lines.close();
  }
  return events;
}

const run = async (args: string[], env: Record<string, string> = newEnv) =>
  JSON.parse(
    (await exec(process.execPath, [cli, ...args], { env, timeout: 90000 }))
      .stdout,
  );
const fails = (args: string[], message: string, env = newEnv) =>
  expect(
    exec(process.execPath, [cli, ...args], { env, timeout: 90000 }),
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
/** Attachment capture stamps its own wall clock; everything else must be identical. */
const converted = (events: { origin: { type: string }; content: unknown }[]) =>
  JSON.parse(
    JSON.stringify(contents(events), (key, value) =>
      key === "capturedAt" ? undefined : value,
    ),
  );

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 45000;
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

/** Publish an OpenCode binding and settle it, returning everything a migration needs. */
async function setup(includeChildren: boolean) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-migrate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: credential,
    port: 0,
  });
  cleanup.push(() => server.close());
  const state = ["--state-dir", root];
  const publishArgs = [
    "--agent",
    "opencode",
    "--native-server",
    native.url,
    "--native-session",
    "ses_test",
    "--server",
    server.url,
    ...(includeChildren ? ["--include-children"] : []),
    ...state,
  ];
  const oldArgs = [...publishArgs, "--visibility", "public"];
  let sourceStreamId = "";
  // Captured counts are unavailable while attached, so watch the recording itself and
  // reattach afterwards until every captured event has been delivered.
  for (let attempt = 0; attempt < 10; attempt++) {
    const events = await publishUntil(oldArgs, baseEnv, () =>
      waitFor(async () => {
        const [current] = (await run(["status", ...state], baseEnv)).bindings;
        if (!current?.streamId) return false;
        sourceStreamId = current.streamId as string;
        return JSON.stringify(
          (await history(server, sourceStreamId)).events,
        ).includes(includeChildren ? "child " : "root ");
      }, "opencode capture"),
    );
    expect(events.some((event) => event.event === "publishing")).toBe(true);
    const [current] = (await run(["status", ...state], baseEnv)).bindings;
    if (current.pendingEvents === 0) break;
  }
  const [binding] = (await run(["status", ...state], baseEnv)).bindings;
  expect(binding.pendingEvents).toBe(0);
  const inspection = await run(
    ["inspect-migration", "--source", binding.bindingDirectory],
    baseEnv,
  );
  expect(inspection.mode).toBe("live");
  return {
    root,
    server,
    native,
    state,
    publishArgs,
    oldArgs,
    sourceStreamId,
    bindingDirectory: binding.bindingDirectory as string,
    manifestHash: inspection.published.manifestHash as string,
  };
}

it("replaces a live OpenCode family binding from a frozen native export, resuming after interruption", async () => {
  const s = await setup(true);
  const { server, native, state, root } = s;
  const oldBefore = await history(server, s.sourceStreamId);
  expect(oldBefore.info.lifecycle).toBe("open");
  expect(JSON.stringify(oldBefore.events)).toContain(SECRET);
  const title = "OpenCode replacement";
  const options = {
    directory: s.bindingDirectory,
    nativeServerOrigin: native.url,
    operationId: "opencode-live-one",
    expectedManifestHash: s.manifestHash,
    disposition: "retain" as const,
    sourceStreamId: s.sourceStreamId,
    ownerCredential: credential,
    secrets: [credential, SECRET],
    title,
    signal: AbortSignal.timeout(90000),
  };
  const args = [
    "migrate-live",
    "--stream",
    s.sourceStreamId,
    "--native-server",
    native.url,
    "--operation-id",
    "opencode-live-one",
    "--expected-manifest-hash",
    s.manifestHash,
    "--old-recording",
    "retain",
    "--title",
    title,
    ...state,
  ];

  // A file source does not apply to an OpenCode binding.
  await fails(
    [
      ...args.slice(0, 3),
      "--native-source",
      join(root, "missing.jsonl"),
      ...args.slice(5),
    ],
    "pass --native-server",
  );
  await fails(
    [...args, "--native-source", join(root, "missing.jsonl")],
    "one of --native-source",
  );
  const before = await snapshotFiles(s.bindingDirectory);

  // Process death after each durable step; every retry resumes the same target.
  for (const failure of ["intent", "imported", "lineage"] as const)
    await expect(
      migrateLiveBinding({
        ...options,
        onPhase: (phase) => {
          if (phase === failure) throw new Error(`died after ${failure}`);
        },
      }),
    ).rejects.toThrow(`died after ${failure}`);
  const intentPath = join(
    root,
    "publisher",
    "live-migrations",
    basename(s.bindingDirectory),
    "intent.json",
  );
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  expect(intent).toMatchObject({
    operationId: "opencode-live-one",
    nativeAgent: "opencode",
    completed: false,
  });
  expect(intent.boundary.children).toHaveLength(1);
  expect(JSON.stringify(intent)).not.toContain(SECRET);
  // The frozen export is the durable source every retry converts.
  const frozenRoot = intent.nativeSourcePath as string;
  expect(frozenRoot.startsWith(intent.frozenDirectory)).toBe(true);
  const frozenBytes = await readFile(frozenRoot);
  expect(frozenBytes.length).toBe(intent.boundary.root.offset);
  // A native session that moves on does not change the pinned target.
  native.update(`root ${SECRET} moved`, `child ${SECRET} moved`);

  // The pending intent fences publishing and competing operations.
  await fails(
    ["publish", ...s.publishArgs],
    "live-binding migration is pending",
    baseEnv,
  );
  await fails(
    args.map((value) => (value === "opencode-live-one" ? "other" : value)),
    "Live migration opencode-live-one is pending",
  );

  // Interrupted between retirement and hand-over: a concurrent import is refused.
  await expect(
    migrateLiveBinding({
      ...options,
      onPhase: (phase) => {
        if (phase === "retired") throw new Error("died after retire");
      },
    }),
  ).rejects.toThrow("died after retire");
  await expect(stat(s.bindingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fails(
    [
      "import",
      "--agent",
      "opencode",
      "--source",
      frozenRoot,
      "--server",
      server.url,
      ...state,
    ],
    "live-binding migration is pending",
  );
  await expect(stat(s.bindingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  // Abandoning is refused once the source binding has been retired.
  await fails([...args, "--abandon"], "already retired the source binding");

  const receipt = await run(args);
  expect(receipt).toMatchObject({
    event: "live-migrated",
    operationId: "opencode-live-one",
    sourceStreamId: s.sourceStreamId,
    sourceConverterVersion: "opencode-live-2",
    targetConverterVersion: "opencode-snapshot-4-family-import-1",
    disposition: "retain",
    visibility: "private",
    frozenBoundary: { sourceBytes: frozenBytes.length, familySources: 1 },
    bindingDirectory: s.bindingDirectory,
    continuation: {
      agent: "opencode",
      title,
      visibility: "private",
      includeChildren: true,
      sourcePath: frozenRoot,
      nativeServerOrigin: native.url,
      resumeImport: true,
    },
    completed: true,
  });
  expect(await run(args)).toEqual(receipt);
  const targetId = receipt.target.streamId as string;
  expect(targetId).not.toBe(s.sourceStreamId);

  const target = await history(server, targetId);
  expect(target.info).toMatchObject({
    title,
    visibility: "private",
    lifecycle: "ended",
    migrationOrigin: {
      operationId: "opencode-live-one",
      sourceStreamId: s.sourceStreamId,
      sourceConverterVersion: "opencode-live-2",
      requestedSourceDisposition: "retain",
    },
  });
  const text = JSON.stringify(target.events);
  expect(text).not.toContain(SECRET);
  expect(text).toContain("child ");
  expect(text).not.toContain("moved");

  // The replacement equals a fresh import of the same frozen export family.
  const fresh = join(root, "fresh-exports");
  await cp(intent.frozenDirectory, fresh, { recursive: true });
  const freshImport = await run([
    "import",
    "--agent",
    "opencode",
    "--source",
    join(fresh, basename(frozenRoot)),
    "--source-root",
    fresh,
    "--include-children",
    "--server",
    server.url,
    "--state-dir",
    join(root, "fresh-state"),
    "--title",
    title,
    "--artifact-base",
    "/",
  ]);
  expect(converted(target.events)).toEqual(
    converted((await history(server, freshImport.streamId)).events),
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
  expect(await snapshotFiles(receipt.retiredDirectory)).toMatchObject({
    "live-migration.json": expect.any(String),
  });
  expect(Object.keys(before).length).toBeGreaterThan(0);

  // Continuing with the old options is rejected; the new options continue live.
  await fails(
    ["publish", ...s.oldArgs, "--source", frozenRoot, "--resume-import"],
    "filtering policy changed",
    baseEnv,
  );
  await publishUntil(
    [
      ...s.publishArgs,
      "--source",
      frozenRoot,
      "--resume-import",
      "--title",
      receipt.continuation.title,
    ],
    newEnv,
    () =>
      waitFor(async () => {
        const events = JSON.stringify((await history(server, targetId)).events);
        return events.includes("root ") && events.includes("moved");
      }, "opencode continuation"),
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
}, 300000);

it("abandons an OpenCode live migration only once its frozen source is gone", async () => {
  const s = await setup(false);
  const { server, native, state, root } = s;
  const options = {
    directory: s.bindingDirectory,
    nativeServerOrigin: native.url,
    operationId: "opencode-abandon",
    expectedManifestHash: s.manifestHash,
    disposition: "retain" as const,
    ownerCredential: credential,
    secrets: [credential, SECRET],
    signal: AbortSignal.timeout(90000),
  };
  // Stop after the replacement recording exists but before the source is ended.
  await expect(
    migrateLiveBinding({
      ...options,
      onPhase: (phase) => {
        if (phase === "imported") throw new Error("died after imported");
      },
    }),
  ).rejects.toThrow("died after imported");
  const intentPath = join(
    root,
    "publisher",
    "live-migrations",
    basename(s.bindingDirectory),
    "intent.json",
  );
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  const stagedStreamId = intent.target.streamId as string;
  expect((await history(server, stagedStreamId)).info.visibility).toBe(
    "private",
  );
  const before = await snapshotFiles(s.bindingDirectory);

  const args = [
    "migrate-live",
    "--abandon",
    "--source",
    s.bindingDirectory,
    "--native-server",
    native.url,
    "--operation-id",
    "opencode-abandon",
    "--expected-manifest-hash",
    s.manifestHash,
    "--old-recording",
    "retain",
    ...state,
  ];
  // The frozen export still reads back, so the migration can still complete.
  await fails(args, "can still complete");
  await fails(
    args.map((value) => (value === "opencode-abandon" ? "another" : value)),
    "abandon it with its own operation ID",
  );

  // A genuinely dead source: the frozen export is gone and the native server has
  // moved on, so no retry can ever convert the pinned bytes again.
  await rm(intent.frozenDirectory, { recursive: true, force: true });
  native.update(`root ${SECRET} moved`, `child ${SECRET} moved`);
  await fails([...args, "--old-recording", "retain"], "--confirm-removal");
  await fails(
    ["migrate-live", ...args.slice(2).filter((value) => value !== "--abandon")],
    "no longer returns the frozen source",
  );

  const receipt = await run([...args, "--confirm-removal"]);
  expect(receipt).toMatchObject({
    event: "live-migration-abandoned",
    operationId: "opencode-abandon",
    sourceStreamId: s.sourceStreamId,
    bindingDirectory: s.bindingDirectory,
    stagedRecording: { streamId: stagedStreamId, disposition: "removed" },
    abandoned: true,
    completed: true,
  });
  expect(await run([...args, "--confirm-removal"])).toEqual(receipt);
  await expect(stat(receipt.stagingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const removed = await fetch(
    `${server.url}/api/v1/streams/${stagedStreamId}`,
    { headers: { authorization: `Bearer ${credential}` } },
  );
  expect(removed.ok).toBe(false);
  // The original binding is byte-for-byte unchanged and still publishable.
  expect(await snapshotFiles(s.bindingDirectory)).toEqual(before);
  await fails(
    ["migrate-live", ...args.slice(2).filter((value) => value !== "--abandon")],
    "was abandoned",
  );
  const source = await history(server, s.sourceStreamId);
  expect(source.info.lifecycle).toBe("open");
  await publishUntil(s.oldArgs, baseEnv, () =>
    waitFor(
      async () =>
        JSON.stringify(
          (await history(server, s.sourceStreamId)).events,
        ).includes("moved"),
      "original binding continues",
    ),
  );
  const after = await history(server, s.sourceStreamId);
  expect(after.info.lifecycle).toBe("open");
  expect(after.events.slice(0, source.events.length)).toEqual(source.events);
  // Detached publishers keep unacknowledged events; reattach until all are delivered.
  for (let attempt = 0; attempt < 10; attempt++) {
    const [current] = (await run(["status", ...state], baseEnv)).bindings;
    if (current.pendingEvents === 0) break;
    await publishUntil(
      s.oldArgs,
      baseEnv,
      () => new Promise((done) => setTimeout(done, 300)),
    );
  }
  // A new operation may still migrate the binding afterwards.
  const second = await run([
    "migrate-live",
    "--source",
    s.bindingDirectory,
    "--native-server",
    native.url,
    "--operation-id",
    "opencode-after-abandon",
    "--expected-manifest-hash",
    (await run(["inspect-migration", "--source", s.bindingDirectory], baseEnv))
      .published.manifestHash,
    "--old-recording",
    "retain",
    ...state,
  ]);
  expect(second.completed).toBe(true);
  expect(second.target.streamId).not.toBe(stagedStreamId);
}, 300000);

it("abandons a Claude live migration whose native transcript was deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-claude-abandon-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: credential,
    port: 0,
  });
  cleanup.push(() => server.close());
  const source = join(root, "abandon.jsonl");
  const row = (id: string, text: string) =>
    JSON.stringify({
      type: "user",
      sessionId: "abandon",
      uuid: id,
      timestamp: "2026-09-01T00:00:01Z",
      message: { content: text },
    }) + "\n";
  await writeFile(source, row("first", `first ${SECRET}`));
  const state = ["--state-dir", root];
  const publishArgs = [
    "--agent",
    "claude",
    "--source",
    source,
    "--server",
    server.url,
    ...state,
  ];
  await publishUntilCaughtUp(publishArgs, baseEnv, state);
  const [binding] = (await run(["status", ...state], baseEnv)).bindings;
  const inspection = await run(
    ["inspect-migration", "--source", binding.bindingDirectory],
    baseEnv,
  );
  const sourceStreamId = binding.streamId as string;
  const before = await snapshotFiles(binding.bindingDirectory);
  const bytes = await readFile(source);
  await expect(
    migrateLiveBinding({
      directory: binding.bindingDirectory,
      nativeSource: source,
      operationId: "claude-abandon",
      expectedManifestHash: inspection.published.manifestHash,
      disposition: "retain",
      ownerCredential: credential,
      secrets: [credential, SECRET],
      signal: AbortSignal.timeout(90000),
      onPhase: (phase) => {
        if (phase === "intent") throw new Error("died after intent");
      },
    }),
  ).rejects.toThrow("died after intent");
  const args = [
    "migrate-live",
    "--abandon",
    "--source",
    binding.bindingDirectory,
    "--native-source",
    source,
    "--operation-id",
    "claude-abandon",
    "--expected-manifest-hash",
    inspection.published.manifestHash,
    "--old-recording",
    "retain",
    ...state,
  ];
  await fails(args, "can still complete");
  await rm(source);
  // No replacement recording was created, so nothing has to be confirmed.
  const receipt = await run(args);
  expect(receipt).toMatchObject({
    event: "live-migration-abandoned",
    operationId: "claude-abandon",
    sourceStreamId,
    stagedRecording: null,
    abandoned: true,
  });
  expect(await snapshotFiles(binding.bindingDirectory)).toEqual(before);
  // The binding publishes again exactly as it was, into the same recording.
  await writeFile(
    source,
    Buffer.concat([bytes, Buffer.from(row("second", "second visible"))]),
  );
  await publishUntilCaughtUp(publishArgs, baseEnv, state);
  const after = await history(server, sourceStreamId);
  expect(after.info.lifecycle).toBe("open");
  expect(JSON.stringify(after.events)).toContain("second visible");
  expect((await run(["status", ...state], baseEnv)).bindings[0].streamId).toBe(
    sourceStreamId,
  );
  // Abandoning twice is a no-op, and the abandoned operation cannot be restarted.
  expect(await run(args)).toEqual(receipt);
  await expect(
    abandonLiveMigration({
      directory: binding.bindingDirectory,
      nativeSource: source,
      operationId: "claude-abandon",
      expectedManifestHash: inspection.published.manifestHash,
      disposition: "retain",
      ownerCredential: credential,
      signal: AbortSignal.timeout(20000),
    }),
  ).resolves.toMatchObject({ abandoned: true });
}, 240000);

/** File publishers report `source-caught-up`; wait for delivery of everything captured. */
async function publishUntilCaughtUp(
  args: string[],
  env: Record<string, string>,
  state: string[],
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(process.execPath, [cli, "publish", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((done) =>
      child.once("exit", done),
    );
    const lines = createInterface({ input: child.stdout! });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("publish did not become live: " + stderr)),
          45000,
        );
        let caughtUp = false,
          live = false;
        lines.on("line", (line) => {
          const event = JSON.parse(line);
          if (event.event === "source-caught-up") caughtUp = true;
          if (event.event === "publisher-status")
            live = event.status === "live";
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
      await new Promise((done) => setTimeout(done, 400));
    } finally {
      child.kill("SIGINT");
      await exited;
      lines.close();
    }
    const [binding] = (await run(["status", ...state], env)).bindings;
    if (binding.pendingEvents === 0) return;
  }
  throw new Error("Publisher did not deliver its captured events");
}

it("rejects an OpenCode source that no longer covers what the binding captured", async () => {
  const s = await setup(false);
  const { native, state, root } = s;
  const before = await snapshotFiles(s.bindingDirectory);
  const args = [
    "migrate-live",
    "--source",
    s.bindingDirectory,
    "--native-server",
    native.url,
    "--operation-id",
    "opencode-inconsistent",
    "--expected-manifest-hash",
    s.manifestHash,
    "--old-recording",
    "retain",
    ...state,
  ];
  // The native server forgot the messages this binding published.
  native.dropMessages(true);
  await fails(args, "no longer shows source objects this binding captured");
  // The native session was recreated under the same identity.
  native.dropMessages(false);
  native.recreate(7);
  await fails(args, "was recreated since this binding captured it");
  native.recreate(1);
  // Nothing durable was written: no intent, and the binding is untouched.
  await expect(
    stat(
      join(
        root,
        "publisher",
        "live-migrations",
        basename(s.bindingDirectory),
        "intent.json",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await snapshotFiles(s.bindingDirectory)).toEqual(before);
  // The consistent source still migrates.
  expect((await run(args)).completed).toBe(true);
}, 240000);
