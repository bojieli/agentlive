import { afterEach, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishOpenCodeRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function nativeServer() {
  let text = "retained";
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("opencode:native-password").toString("base64")}`
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"server.connected"}\n\n');
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/session/ses_test")
      res.end(JSON.stringify({ id: "ses_test", time: { created: 1 } }));
    else if (req.url === "/session/ses_test/message")
      res.end(
        JSON.stringify([
          {
            info: {
              id: "msg1",
              sessionID: "ses_test",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [
              {
                id: "part1",
                type: "text",
                sessionID: "ses_test",
                messageID: "msg1",
                text,
              },
            ],
          },
        ]),
      );
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stop = async () => {
    for (const res of clients) res.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(stop);
  return {
    url: `http://127.0.0.1:${port}`,
    stop,
    start: () =>
      new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    update: (value: string) => {
      text = value;
      for (const res of clients)
        res.write('data: {"type":"message.updated"}\n\n');
    },
  };
}
it("publishes retained OpenCode history, recovers native disconnects, and resumes the same recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-publish-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const options = {
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential: "b".repeat(64),
    nativeServerOrigin: native.url,
    nativeSessionId: "ses_test",
    nativePassword: "native-password",
    title: "OpenCode live",
    visibility: "private" as const,
  };
  await expect(
    publishOpenCodeRecording({
      ...options,
      nativePassword: "incorrect",
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toThrow("401");
  let streamId = "";
  let captured = 0;
  let failure: unknown;
  let controller = new AbortController();
  let running: Promise<void>;
  const begin = () => {
    running = publishOpenCodeRecording({
      ...options,
      signal: controller.signal,
      onReady: (recording) => {
        if (streamId) expect(recording.streamId).toBe(streamId);
        streamId = recording.streamId;
      },
      onCaptured: (boundary) => {
        captured = boundary.producerEvents;
      },
    }).catch((error) => {
      failure = error;
    });
  };
  const until = async (text: string) => {
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
            [...state.messages.values()].some(
              (message) => message.text === text,
            )
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
  };
  begin();
  try {
    await until("retained");
    await native.stop();
    native.update("after native reconnect");
    await native.start();
    await until("after native reconnect");
    controller.abort();
    await running!;
    const baseline = (await server.store.get(streamId)).boundary.sequence;
    const { PublisherJournal } =
      await import("../../packages/publisher/src/index.js");
    const saved = await PublisherJournal.open(options.publisherRoot, {
      serverOrigin: server.url,
      agent: "opencode",
      nativeSessionId: "ses_test",
    });
    const manifestPath = join(saved.directory, "publish.json");
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    previous.converterVersion = "opencode-live-1";
    await writeFile(manifestPath, JSON.stringify(previous));
    const identityBefore = {
      streamId: saved.identity.streamId,
      writeSecret: saved.identity.writeSecret,
      producerEpoch: saved.identity.producerEpoch,
    };
    await saved.close();

    controller = new AbortController();
    captured = 0;
    begin();
    await until("after native reconnect");
    expect((await server.store.get(streamId)).boundary.sequence).toBe(baseline);
    expect(
      JSON.parse(await readFile(manifestPath, "utf8")).converterVersion,
    ).toBe("opencode-live-2");
    expect(streamId).toBe(identityBefore.streamId);
    expect(
      JSON.parse(await readFile(join(saved.directory, "binding.json"), "utf8")),
    ).toMatchObject(identityBefore);

    native.update("continued after publisher restart");
    await until("continued after publisher restart");
    expect(
      (await fetch(`${server.url}/api/v1/streams/${streamId}`)).status,
    ).toBe(403);
  } finally {
    controller.abort();
    await running!;
  }
  const { PublisherJournal } =
    await import("../../packages/publisher/src/index.js");
  const retained = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: server.url,
    agent: "opencode",
    nativeSessionId: "ses_test",
  });
  const policyPath = join(retained.directory, "publish.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  await retained.close();
  policy.converterVersion = "opencode-live-1";
  await writeFile(policyPath, JSON.stringify(policy));
  await expect(
    publishOpenCodeRecording({
      ...options,
      title: "changed",
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toThrow("options changed");
  expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(policy);
  policy.converterVersion = "opencode-live-unknown";
  await writeFile(policyPath, JSON.stringify(policy));
  await expect(
    publishOpenCodeRecording({ ...options, signal: AbortSignal.timeout(5000) }),
  ).rejects.toThrow("options changed");
  expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(policy);
}, 30000);

it("exposes OpenCode publishing through the CLI without a source file or password argument", async () => {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const child = spawn(
    process.execPath,
    [
      resolve("packages/cli/dist/main.js"),
      "publish",
      "--agent",
      "opencode",
      "--native-server",
      native.url,
      "--native-session",
      "ses_test",
      "--server",
      server.url,
      "--state-dir",
      root,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        AGENTLIVE_OWNER_SECRET: "b".repeat(64),
        OPENCODE_SERVER_PASSWORD: "native-password",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  try {
    await expect
      .poll(
        () => {
          if (diagnostic) throw new Error(diagnostic);
          return output;
        },
        { timeout: 10000 },
      )
      .toContain('"status":"observing"');
    expect(output).toContain('"event":"publishing"');
    expect(output).not.toContain("native-password");
    expect(output).not.toContain("b".repeat(64));
  } finally {
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
  }
}, 20000);
it("continues durable capture while the AgentLive server is offline and sends the backlog after recovery", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-offline-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  let server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const origin = server.url;
  const controller = new AbortController();
  let streamId = "";
  let captured = 0;
  let failure: unknown;
  const running = publishOpenCodeRecording({
    publisherRoot: join(root, "publisher"),
    serverOrigin: origin,
    ownerCredential: "b".repeat(64),
    nativeServerOrigin: native.url,
    nativeSessionId: "ses_test",
    nativePassword: "native-password",
    title: "Offline recovery",
    visibility: "private",
    signal: controller.signal,
    onReady: (recording) => {
      streamId = recording.streamId;
    },
    onCaptured: (boundary) => {
      captured = boundary.producerEvents;
    },
  }).catch((error) => {
    failure = error;
  });
  try {
    await expect
      .poll(
        () => {
          if (failure) throw failure;
          return captured;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    const before = captured;
    await server.close();
    native.update("durable while offline");
    await expect
      .poll(
        () => {
          if (failure) throw failure;
          return captured;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(before);
    const directory = (await readdir(join(root, "publisher")))[0]!;
    expect(
      await readFile(
        join(root, "publisher", directory, "capture.jsonl"),
        "utf8",
      ),
    ).toContain("durable while offline");
    server = await startServer({
      directory: join(root, "server"),
      ownerSecret: "b".repeat(64),
      port: Number(new URL(origin).port),
    });
    await expect
      .poll(
        async () => {
          if (failure) throw failure;
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
            [...state.messages.values()].some(
              (message) => message.text === "durable while offline",
            )
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
}, 20000);
