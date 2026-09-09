#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "@agentlive/server";
import {
  importClaudeRecording,
  importCodexRecording,
  importKimiRecording,
  importOpenCodeRecording,
} from "@agentlive/adapters";
import { StreamingRedactor } from "@agentlive/publisher";
import { ownerCredential, validateSecret } from "./credentials.js";
const help = `AgentLive — record and share coding-agent sessions

Commands:
  agentlive serve [--host 127.0.0.1] [--port 7331]
  agentlive import --agent <codex|claude|kimi|opencode> --source <file>

Shared options:
  --state-dir <directory>  Persistent state (default: ~/.agentlive)
  --owner-file <file>      Owner credential JSON (default: <state-dir>/owner.json)
  --help                  Show this help

Import options:
  --server <origin>       Server origin (default: http://127.0.0.1:7331)
  --visibility <mode>     private (default), unlisted, or public
  --title <text>          Recording title
  --artifact-root <path>  Allowed local artifact root; repeat for multiple roots
  --artifact-base <path>  Base directory for relative artifact paths
  --native-session <id>   Kimi session ID for a moved wire export
  --native-agent <id>     Kimi agent ID for a moved wire export

AGENTLIVE_OWNER_SECRET may supply an existing owner credential without a file.
Import captures privately and shares only after all captured events are durable.
`;
const controller = new AbortController();
let interrupted = 0;
const onInt = () => {
  interrupted = 130;
  controller.abort();
};
const onTerm = () => {
  interrupted = 143;
  controller.abort();
};
process.once("SIGINT", onInt);
process.once("SIGTERM", onTerm);
const secrets = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) &&
      value &&
      value.length >= 8 &&
      value.length <= 4096,
  )
  .map(([, value]) => value!);
async function main() {
  const version = process.versions.node.split(".").map(Number);
  if (
    version[0] !== 26 ||
    (version[1] ?? 0) < 8 ||
    (version[1] === 8 && (version[2] ?? 0) < 1)
  )
    throw new Error("AgentLive requires Node 26.8.1 or newer within Node 26");
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  if (command !== "serve" && command !== "import")
    throw new Error("Unknown command; use agentlive --help");
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      "state-dir": { type: "string" },
      "owner-file": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      agent: { type: "string" },
      source: { type: "string" },
      server: { type: "string" },
      visibility: { type: "string" },
      title: { type: "string" },
      "artifact-root": { type: "string", multiple: true },
      "artifact-base": { type: "string" },
      "native-session": { type: "string" },
      "native-agent": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const allowed = new Set([
    "help",
    "state-dir",
    "owner-file",
    ...(command === "serve"
      ? ["host", "port"]
      : [
          "agent",
          "source",
          "server",
          "visibility",
          "title",
          "artifact-root",
          "artifact-base",
          "native-session",
          "native-agent",
        ]),
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key)))
    throw new Error("Option does not apply to this command; use --help");
  const stateDir = resolve(
    values["state-dir"] ?? join(homedir(), ".agentlive"),
  );
  const ownerFile = resolve(
    values["owner-file"] ?? join(stateDir, "owner.json"),
  );
  if (command === "serve") {
    const port = Number(values.port ?? 7331);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error("Port must be an integer from 0 to 65535");
    const secret = process.env.AGENTLIVE_OWNER_SECRET
      ? validateSecret(process.env.AGENTLIVE_OWNER_SECRET)
      : await ownerCredential(ownerFile, true);
    secrets.push(secret);
    const server = await startServer({
      directory: join(stateDir, "server"),
      ownerSecret: secret,
      host: values.host ?? "127.0.0.1",
      port,
    });
    try {
      process.stdout.write(
        JSON.stringify({
          event: "ready",
          url: server.url,
          ...(process.env.AGENTLIVE_OWNER_SECRET ? {} : { ownerFile }),
        }) + "\n",
      );
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    } finally {
      await server.close();
    }
    return;
  }
  const agent = values.agent,
    sourcePath = values.source;
  if (
    !agent ||
    !["codex", "claude", "kimi", "opencode"].includes(agent) ||
    !sourcePath
  )
    throw new Error(
      "Import requires --agent codex|claude|kimi|opencode and --source <file>",
    );
  const visibility = values.visibility ?? "private";
  if (
    visibility !== "private" &&
    visibility !== "public" &&
    visibility !== "unlisted"
  )
    throw new Error("Visibility must be private, unlisted, or public");
  if (
    Boolean(values["native-session"]) !== Boolean(values["native-agent"]) ||
    (agent !== "kimi" && (values["native-session"] || values["native-agent"]))
  )
    throw new Error(
      "Specify both native identity options only for Kimi exports",
    );
  const secret = process.env.AGENTLIVE_OWNER_SECRET
    ? validateSecret(process.env.AGENTLIVE_OWNER_SECRET)
    : await ownerCredential(ownerFile, false);
  secrets.push(secret);
  const options: Parameters<typeof importCodexRecording>[0] = {
    sourcePath: resolve(sourcePath),
    publisherRoot: join(stateDir, "publisher"),
    serverOrigin: values.server ?? "http://127.0.0.1:7331",
    ownerCredential: secret,
    title: values.title ?? `Imported ${agent} session`,
    visibility,
    secrets,
    signal: controller.signal,
    ...(values["artifact-root"]
      ? { artifactRoots: values["artifact-root"] }
      : {}),
    ...(values["artifact-base"]
      ? { artifactBaseDirectory: values["artifact-base"] }
      : {}),
  };
  const result =
    agent === "codex"
      ? await importCodexRecording(options)
      : agent === "claude"
        ? await importClaudeRecording(options)
        : agent === "opencode"
          ? await importOpenCodeRecording(options)
          : await importKimiRecording({
              ...options,
              ...(values["native-session"] && values["native-agent"]
                ? {
                    nativeIdentity: {
                      nativeSessionId: values["native-session"],
                      agentId: values["native-agent"],
                    },
                  }
                : {}),
            });
  process.stdout.write(
    JSON.stringify({ event: "imported", agent, visibility, ...result }) + "\n",
  );
}
try {
  await main();
  process.exitCode = interrupted;
} catch (error) {
  if (interrupted) process.exitCode = interrupted;
  else {
    try {
      const filter = new StreamingRedactor(secrets);
      const message = error instanceof Error ? error.message : "Command failed";
      process.stderr.write(
        JSON.stringify({
          event: "error",
          message: filter.push(message) + filter.finish(),
        }) + "\n",
      );
    } catch {
      process.stderr.write(
        "Command failed; unable to safely format error details.\n",
      );
    }
    process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
}
