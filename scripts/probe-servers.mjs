#!/usr/bin/env node
/** Opt-in synthetic live-server probe. Raw events remain in ignored local output. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const agent = process.argv[2];
if (!["kimi", "opencode"].includes(agent))
  throw new Error("Usage: node scripts/probe-servers.mjs kimi|opencode");
const output = resolve(
  "probe-results",
  `${agent}-server-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(join(tmpdir(), "agentlive-server-probe-"));
await writeFile(
  join(workspace, "README.md"),
  "# Synthetic transport probe\nNo private project content.\n",
);
const allocator = createServer();
await new Promise((r) => allocator.listen(0, "127.0.0.1", r));
const port = allocator.address().port;
await new Promise((r) => allocator.close(r));
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(32).toString("hex");
const proc = spawn(
  agent,
  agent === "kimi"
    ? ["web", "--no-open", "--port", String(port)]
    : ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: workspace,
    env: {
      ...process.env,
      ...(agent === "opencode" ? { OPENCODE_SERVER_PASSWORD: password } : {}),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let startup = "";
let processEnded = false;
let ws;
let token;
proc.on("exit", () => {
  processEnded = true;
});
proc.stdout.on("data", (chunk) => {
  startup += chunk.toString();
});
proc.stderr.on("data", (chunk) => {
  startup += chunk.toString();
});
const kill = () => {
  try {
    process.platform === "win32"
      ? proc.kill("SIGTERM")
      : process.kill(-proc.pid, "SIGTERM");
  } catch {}
};
const abort = new AbortController();
const timeout = setTimeout(
  () => abort.abort(new Error("Probe deadline exceeded")),
  120_000,
);
const events = [];
const start = performance.now();
let sessionId;
let finished = false;
let turnFailure;
const assistantMessages = new Set();
const record = (event) => {
  events.push({ elapsedMs: performance.now() - start, event });
  if (
    event.type === "message.updated" &&
    event.properties?.info?.role === "assistant"
  )
    assistantMessages.add(event.properties.info.id);
  for (const op of event.payload?.ops ?? [])
    if (op.op === "turn.upsert") {
      if (op.turn.state === "completed") finished = true;
      if (op.turn.state === "failed" || op.turn.state === "interrupted")
        turnFailure = op.turn.error ?? op.turn.state;
    }
};
let readerTask;
try {
  for (let i = 0; i < 150; i++) {
    if (processEnded) throw new Error("Server exited during startup");
    token = startup.match(/#token=([A-Za-z0-9._~-]+)/)?.[1];
    try {
      const health = await fetch(
        `${base}${agent === "kimi" ? "/api/v1/health" : "/global/health"}`,
        {
          signal: AbortSignal.timeout(500),
          headers:
            agent === "opencode"
              ? {
                  Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
                }
              : {},
        },
      );
      if (health.ok && (agent !== "kimi" || token)) break;
    } catch {}
    await delay(100);
  }
  const headers =
    agent === "kimi"
      ? { Authorization: `Bearer ${token}` }
      : {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        };
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${path}`);
    const json = await response.json();
    if (agent === "kimi") {
      if (json.code !== 0) throw new Error(`Kimi ${json.code}: ${json.msg}`);
      return json.data;
    }
    return json;
  };
  const session = await request(
    agent === "kimi" ? "/api/v1/sessions" : "/session",
    agent === "kimi"
      ? { metadata: { cwd: workspace } }
      : { title: "AgentLive synthetic live capture" },
  );
  sessionId = session.id;
  if (!sessionId) throw new Error("No native session ID");
  if (agent === "kimi") {
    await request(`/api/v1/sessions/${sessionId}/profile`, {
      agent_config: {
        model: process.env.AGENTLIVE_PROBE_KIMI_MODEL ?? "kimi-code/k3",
      },
    });
    ws = new WebSocket(base.replace("http:", "ws:") + "/api/v1/ws", [
      `kimi-code.bearer.${token}`,
    ]);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
    });
    let ack = false;
    ws.onmessage = (message) => {
      const event = JSON.parse(message.data);
      record(event);
      if (event.type === "ack" && event.id === "subscribe") {
        if (event.code !== 0)
          abort.abort(new Error(`Subscribe failed: ${event.code}`));
        else ack = true;
      }
    };
    ws.send(
      JSON.stringify({
        type: "client_hello",
        id: "hello",
        payload: { client_id: "agentlive_probe" },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "subscribe_v2",
        id: "subscribe",
        payload: { session_id: sessionId, transcript: { "*": "delta" } },
      }),
    );
    for (let i = 0; i < 100 && !ack; i++) {
      abort.signal.throwIfAborted();
      await delay(50);
    }
    if (!ack) throw new Error("Subscribe ACK timeout");
  } else {
    const response = await fetch(base + "/event", {
      headers,
      signal: abort.signal,
    });
    if (!response.ok) throw new Error("SSE subscription failed");
    readerTask = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = block
            .split("\n")
            .filter((x) => x.startsWith("data:"))
            .map((x) => x.slice(5).trimStart())
            .join("\n");
          if (data) record(JSON.parse(data));
        }
      }
    })().catch((error) => {
      if (!abort.signal.aborted) throw error;
    });
  }
  const prompt =
    "This is a synthetic streaming transport test. Do not use tools or read any files. Write three short paragraphs about rain gauges, then end with AGENTLIVE_SERVER_OK.";
  if (agent === "kimi") {
    await request(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: "text", text: prompt }],
    });
    for (let i = 0; i < 1000; i++) {
      abort.signal.throwIfAborted();
      if (turnFailure) throw new Error(`Agent turn failed: ${turnFailure}`);
      if (finished) break;
      await delay(100);
    }
  } else {
    const model =
      process.env.AGENTLIVE_PROBE_MODEL ?? "google/gemini-3.8-flash";
    const slash = model.indexOf("/");
    await request(`/session/${sessionId}/message`, {
      model: {
        providerID: model.slice(0, slash),
        modelID: model.slice(slash + 1),
      },
      parts: [{ type: "text", text: prompt }],
    });
    if (events.some((x) => x.event.type === "session.error"))
      throw new Error("OpenCode emitted session.error; see private trace");
    finished = true;
    await delay(300);
  }
  const types = {};
  for (const { event } of events)
    types[event.type] = (types[event.type] ?? 0) + 1;
  const summary = {
    agent,
    sessionId,
    finished,
    elapsedMs: Math.round(performance.now() - start),
    eventCount: events.length,
    types,
    markerObserved:
      agent === "kimi"
        ? JSON.stringify(
            events
              .flatMap((x) => x.event.payload?.ops ?? [])
              .filter(
                (op) =>
                  op.op.startsWith("frame.") || op.op.startsWith("block."),
              ),
          ).includes("AGENTLIVE_SERVER_OK")
        : events.some(
            (x) =>
              x.event.type === "message.part.updated" &&
              x.event.properties?.part?.type === "text" &&
              assistantMessages.has(x.event.properties?.part?.messageID) &&
              x.event.properties?.part?.text?.includes("AGENTLIVE_SERVER_OK"),
          ),
  };
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(`${agent} probe failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  ws?.close();
  abort.abort();
  await readerTask?.catch(() => {});
  kill();
  await writeFile(
    join(output, "events.jsonl"),
    events.map((x) => JSON.stringify(x)).join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(join(output, "startup.log"), startup, { mode: 0o600 });
  console.log(`Private output: ${output}`);
}
