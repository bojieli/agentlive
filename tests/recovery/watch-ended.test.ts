import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../packages/server/src/http.js";
import { watchRecording } from "../../packages/cli/src/watch.js";
import { SubscriberCache } from "../../packages/storage/src/index.js";
import type { PublishedEvent } from "../../packages/protocol/src/index.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const running: { abort: AbortController; done: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const run of running) run.abort.abort();
  await Promise.all(running.splice(0).map((x) => x.done.catch(() => {})));
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const writeSecret = "a".repeat(64);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-watch-ended-"));
  roots.push(root);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  servers.push(server);
  const session = await server.store.create({
    ownerId: "local",
    requestId: "req1",
    requestedAt: new Date().toISOString(),
    publisherId: "pub1",
    producerEpoch: "epoch1",
    writeSecret,
    title: "Ended watch",
    visibility: "public",
  });
  let attempt = 1;
  let { lease } = await session.resume(writeSecret, {
    publisherId: "pub1",
    producerEpoch: "epoch1",
    attempt,
    revision: session.info.revision,
  });
  let producerSeq = 0;
  const publish = async (...texts: string[]) => {
    const events: PublishedEvent[] = [];
    for (const text of texts) {
      const messageId = `m${producerSeq + 1}`;
      for (const content of [
        {
          kind: "message.started" as const,
          payload: { messageId, role: "assistant" as const },
        },
        {
          kind: "message.text.append" as const,
          payload: { messageId, text },
        },
        { kind: "message.completed" as const, payload: { messageId } },
      ])
        events.push({
          protocolVersion: 1,
          streamId: session.info.id,
          producerEpoch: "epoch1",
          producerSeq: ++producerSeq,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock1",
          elapsedMs: producerSeq * 1000,
          fidelity: "delta",
          source: { agent: "synthetic", sessionId: "native1" },
          content,
        });
    }
    await session.append(lease, events);
  };
  let operations = 0;
  let lifecycleSeq = 1;
  const end = async () => {
    lifecycleSeq = (
      await session.lifecycle(writeSecret, `op${++operations}`, lifecycleSeq, {
        kind: "recording.ended",
        payload: { producerEpoch: "epoch1", throughProducerSeq: producerSeq },
      })
    ).serverSeq;
  };
  const reopen = async () => {
    lifecycleSeq = (
      await session.lifecycle(writeSecret, `op${++operations}`, lifecycleSeq, {
        kind: "recording.reopened",
        payload: {},
      })
    ).serverSeq;
    lease = (
      await session.resume(writeSecret, {
        publisherId: "pub1",
        producerEpoch: "epoch1",
        attempt: ++attempt,
        revision: session.info.revision,
      })
    ).lease;
  };
  return { root, server, session, publish, end, reopen };
}
/** Resolve to "finished" only when the watch ends on its own before the deadline. */
function within<T>(work: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.then(() => "finished" as const),
    new Promise<"pending">((r) => {
      timer = setTimeout(() => r("pending"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function watch(options: Parameters<typeof watchRecording>[0]) {
  const abort = new AbortController();
  const done = watchRecording({
    ...options,
    signal: AbortSignal.any([options.signal, abort.signal]),
  });
  void done.catch(() => {});
  running.push({ abort, done });
  return { abort, done };
}

it("finishes a non-interactive watch of an ended recording without a key or signal", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("first message", "second message");
  await end();
  let output = "";
  const idle = new AbortController();
  const { done } = watch({
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    signal: idle.signal,
    write: async (text) => {
      output += text;
    },
  });
  expect(await within(done, 20_000)).toBe("finished");
  await done;
  expect(idle.signal.aborted).toBe(false);
  expect(output).toContain("first message");
  expect(output).toContain("second message");
  expect(output).toContain("Recording ended");
}, 30_000);

it("finishes once a recording being watched ends", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("before the end");
  let output = "";
  let ending: Promise<void> | undefined;
  const { done } = watch({
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    signal: new AbortController().signal,
    write: async (text) => {
      output += text;
      if (output.includes("before the end") && !ending) {
        ending = end();
        void ending.catch(() => {});
      }
    },
  });
  expect(await within(done, 20_000)).toBe("finished");
  await ending;
  await done;
  expect(output).toContain("before the end");
  expect(output).toContain("Recording ended");
}, 30_000);

it("keeps an ended recording attached with follow until the viewer stops", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("followed message");
  await end();
  let output = "";
  const { abort, done } = watch({
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    follow: true,
    signal: new AbortController().signal,
    write: async (text) => {
      output += text;
    },
  });
  expect(await within(done, 5_000)).toBe("pending");
  expect(output).toContain("followed message");
  expect(output).toContain("Recording ended");
  abort.abort();
  await done;
}, 30_000);

it("keeps an interactive watch open at the ended boundary", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("interactive message");
  await end();
  const stdin = process.stdin as unknown as {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  const wasTTY = stdin.isTTY;
  const wasSetRawMode = stdin.setRawMode;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let output = "";
  try {
    const { abort, done } = watch({
      serverOrigin: server.url,
      streamId: session.info.id,
      credential: "b".repeat(64),
      cacheRoot: join(root, "viewer"),
      interactive: true,
      signal: new AbortController().signal,
      write: async (text) => {
        output += text;
      },
    });
    expect(await within(done, 5_000)).toBe("pending");
    abort.abort();
    await done;
  } finally {
    stdin.isTTY = wasTTY;
    stdin.setRawMode = wasSetRawMode;
  }
  expect(output).toContain("interactive message");
  expect(output).toContain("Recording ended");
}, 30_000);

it("keeps following a cached ended prefix that the server has since reopened", async () => {
  const { root, server, session, publish, end, reopen } = await setup();
  await publish("before the reopen");
  await end();
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    signal: new AbortController().signal,
  };
  let cached = "";
  const first = watch({
    ...settings,
    write: async (text) => {
      cached += text;
    },
  });
  expect(await within(first.done, 20_000)).toBe("finished");
  await first.done;
  expect(cached).toContain("Recording ended");
  await reopen();
  await publish("after the reopen");
  let output = "";
  const second = watch({
    ...settings,
    write: async (text) => {
      output += text;
    },
  });
  // The cached prefix ends the recording, but the server has more to show.
  expect(await within(second.done, 5_000)).toBe("pending");
  expect(output).toContain("after the reopen");
  second.abort.abort();
  await second.done;
}, 40_000);

it("waits instead of finishing when the server cannot confirm the ended boundary", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("cached message");
  await end();
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    signal: new AbortController().signal,
  };
  const first = watch({ ...settings, write: async () => {} });
  expect(await within(first.done, 20_000)).toBe("finished");
  await first.done;
  await servers.splice(servers.indexOf(server), 1)[0]!.close();
  let output = "";
  const offline = watch({
    ...settings,
    write: async (text) => {
      output += text;
    },
  });
  // Without the server, a reopen past the cached end cannot be ruled out.
  expect(await within(offline.done, 3_000)).toBe("pending");
  expect(output).toContain("cached message");
  expect(output).toContain("Recording ended");
  offline.abort.abort();
  await offline.done;
}, 40_000);

it("quits a non-interactive terminal watch of an open recording on q", async () => {
  const { root, server, session, publish } = await setup();
  await publish("still open message");
  const stdin = process.stdin as unknown as {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  const wasTTY = stdin.isTTY;
  const wasSetRawMode = stdin.setRawMode;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let output = "";
  try {
    const { done } = watch({
      serverOrigin: server.url,
      streamId: session.info.id,
      credential: "b".repeat(64),
      cacheRoot: join(root, "viewer"),
      signal: new AbortController().signal,
      write: async (text) => {
        output += text;
      },
    });
    expect(await within(done, 2_000)).toBe("pending");
    expect(output).toContain("still open message");
    process.stdin.emit("data", Buffer.from("q"));
    expect(await within(done, 10_000)).toBe("finished");
    await done;
  } finally {
    stdin.isTTY = wasTTY;
    stdin.setRawMode = wasSetRawMode;
  }
}, 30_000);

it("keeps a saved viewing position across the finishing exit path", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("saved position message");
  await end();
  const cacheRoot = join(root, "viewer");
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot,
    resumeView: true,
    signal: new AbortController().signal,
  };
  let output = "";
  const first = watch({
    ...settings,
    write: async (text) => {
      output += text;
    },
  });
  expect(await within(first.done, 20_000)).toBe("finished");
  await first.done;
  const cache = await SubscriberCache.open(cacheRoot, {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => {
      throw new Error("The cache must already exist");
    },
  });
  const saved = await cache.loadPresentationPosition();
  const received = cache.cursor.serverSeq;
  await cache.close();
  expect(saved.serverSeq).toBe(received);
  expect(saved.serverSeq).toBeGreaterThan(0);
  let resumedOutput = "";
  const second = watch({
    ...settings,
    write: async (text) => {
      resumedOutput += text;
    },
  });
  expect(await within(second.done, 20_000)).toBe("finished");
  await second.done;
  // The resumed viewer shows the saved position as a state view, not the stream again.
  expect(resumedOutput).toContain("Recording ended");
  expect(resumedOutput).toContain("saved position message");
}, 40_000);

it("exits zero from the command line with one status line on stderr", async () => {
  const { root, server, session, publish, end } = await setup();
  await publish("command line message");
  await end();
  const child = spawn(
    process.execPath,
    [
      resolve("packages/cli/dist/main.js"),
      "watch",
      "--stream",
      session.info.id,
      "--server",
      server.url,
      "--anonymous",
      "--state-dir",
      join(root, "cli"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const code = await new Promise<number | null>((done) =>
    child.once("exit", (status) => done(status)),
  );
  clearTimeout(timer);
  expect(code).toBe(0);
  expect(stdout).toContain("command line message");
  expect(stdout.trimEnd().endsWith("Recording ended")).toBe(true);
  expect(stderr).toBe(
    "Recording ended; watch finished. Use --follow to stay attached for a reopen.\n",
  );
}, 40_000);
