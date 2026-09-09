#!/usr/bin/env node
/** Opt-in live probes: never run in CI. Uses only a new synthetic workspace. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

const output = resolve(
  "probe-results",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(join(tmpdir(), "agentlive-probe-"));
await writeFile(
  join(workspace, "README.md"),
  "# Synthetic AgentLive capture probe\nNo private project content.\n",
);
const prompt =
  "This is a synthetic streaming transport test. Do not use tools, read files, or access the network. Write three short paragraphs explaining how a rain gauge works, then finish with the exact text AGENTLIVE_PROBE_OK.";
const selected = process.argv.slice(2);
const agents = selected.length
  ? selected
  : ["claude", "codex", "kimi", "opencode"];

async function probe(agent) {
  const args = {
    claude: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ],
    codex: ["app-server", "--stdio"],
    kimi: ["-p", prompt, "--output-format", "stream-json"],
    opencode: [
      "run",
      "--format",
      "json",
      "--pure",
      ...(process.env.AGENTLIVE_PROBE_MODEL
        ? ["--model", process.env.AGENTLIVE_PROBE_MODEL]
        : []),
      prompt,
    ],
  }[agent];
  if (!args) throw new Error(`Unknown agent: ${agent}`);
  const start = performance.now();
  const proc = spawn(agent, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const events = [];
  let stderr = "";
  let timedOut = false;
  let complete = false;
  let threadId;
  const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);
  const kill = () => {
    try {
      process.platform === "win32"
        ? proc.kill("SIGTERM")
        : process.kill(-proc.pid, "SIGTERM");
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120_000);
  const rl = createInterface({ input: proc.stdout });
  proc.stderr.on("data", (chunk) => {
    if (stderr.length < 128_000) stderr += chunk.toString();
  });
  rl.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = { unparsed: line };
    }
    events.push({
      elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
      event,
    });
    if (agent !== "codex") return;
    if (event.id === 1 && event.result) {
      send({ method: "initialized", params: {} });
      send({
        id: 2,
        method: "thread/start",
        params: {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
        },
      });
    }
    if (event.id === 2 && event.result?.thread?.id) {
      threadId = event.result.thread.id;
      send({
        id: 3,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: prompt }] },
      });
    }
    if (event.method === "turn/completed") {
      complete = true;
      kill();
    }
    if (event.id !== undefined && event.method)
      send({
        id: event.id,
        error: {
          code: -32601,
          message: "Probe does not support interactive requests",
        },
      });
    if (event.error && event.id !== undefined) kill();
  });
  if (agent === "codex")
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agentlive_probe", version: "0.1.0" } },
    });
  else proc.stdin.end();
  const result = await new Promise((done) => {
    proc.on("error", (error) => done({ error: error.message }));
    proc.on("exit", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  rl.close();
  const types = {};
  for (const { event } of events) {
    const type = event.method ?? event.type ?? "response";
    types[type] = (types[type] ?? 0) + 1;
  }
  if (agent === "claude")
    complete = events.some(
      (x) =>
        x.event.type === "result" &&
        !x.event.is_error &&
        x.event.subtype === "success",
    );
  if (agent === "kimi")
    complete =
      result.code === 0 &&
      events.some((x) => x.event.role === "assistant" && x.event.content);
  const generated = events.filter((x) =>
    agent === "codex"
      ? x.event.method === "item/completed" &&
        x.event.params?.item?.type === "agentMessage"
      : agent === "claude"
        ? x.event.type === "assistant"
        : x.event.role === "assistant",
  );
  const summary = {
    agent,
    ...result,
    timedOut,
    complete,
    threadId,
    elapsedMs: Math.round(performance.now() - start),
    eventCount: events.length,
    types,
    markerObserved: JSON.stringify(generated).includes("AGENTLIVE_PROBE_OK"),
  };
  await writeFile(
    join(output, `${agent}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(join(output, `${agent}.stderr`), stderr, { mode: 0o600 });
  await writeFile(
    join(output, `${agent}.summary.json`),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
}
console.log(`Private probe output: ${output}`);
console.log(`Synthetic workspace: ${workspace}`);
await Promise.all(agents.map(probe));
