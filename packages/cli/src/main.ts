#!/usr/bin/env node
import { migrateRecording } from "./migrate-recording.js";
import { finishPublisher } from "@agentlive/publisher";
import { migrateImport } from "./migrate-import.js";
import {
  migrateLiveBinding,
  resolveLiveMigrationDirectory,
  liveMigrationServerOrigin,
} from "./migrate-live.js";
import {
  inspectMigration,
  relocateImportSources,
} from "./inspect-migration.js";
import { manageViewingGrants } from "./viewing-grants.js";
import {
  accountCredential,
  loginAccount,
  logoutAccount,
} from "./account-login.js";
import { loadHostedConfig } from "./hosted-config.js";
import { loadRemoteArtifactPolicy } from "./remote-artifact-policy.js";
import {
  listReports,
  decideReport,
  listAccounts,
  setAccountDisabled,
  readVisibility,
  changeVisibility,
  listRecordings,
  removeRecording,
  requestOnlineBackup,
} from "@agentlive/client";
import { watchRecording } from "./watch.js";
import {
  publisherStatus,
  findBinding,
  setPublisherSharing,
  finishBinding,
  reopenBinding,
  retireBinding,
  viewerUrl,
} from "./publication.js";
import { doctor } from "./doctor.js";
import { replayRecording } from "./replay.js";
import { exportRecording } from "./export.js";
import { importArchiveRecording } from "./import-archive.js";
import { managedFileResume } from "./managed-launch.js";
import { launchNewClaude } from "./new-claude.js";
import { launchNewKimi } from "./new-kimi.js";
import { launchNewCodex } from "./new-codex.js";
import { launchManagedOpenCode } from "./managed-opencode.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@agentlive/protocol";
import { parseArgs } from "node:util";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import {
  startServer,
  backupServer,
  restoreServer,
  ShutdownTimeoutError,
} from "@agentlive/server";
import {
  discoverNativeSessions,
  selectNativeSession,
  publishCodexRecording,
  publishClaudeRecording,
  publishKimiRecording,
  publishOpenCodeRecording,
  importClaudeRecording,
  importCodexRecording,
  importKimiRecording,
  importOpenCodeRecording,
} from "@agentlive/adapters";
import {
  recoverPublisher,
  rotatePublisherCredential,
  StreamingRedactor,
} from "@agentlive/publisher";
import { publisherCredential } from "./publisher-credential.js";
import {
  ownerCredential,
  validateSecret,
  viewingCredential,
} from "./credentials.js";
const help = `AgentLive — record and share coding-agent sessions

Everyday commands:
  agentlive serve                        Start a local server (http://127.0.0.1:7331)
  agentlive publish --agent <agent> ...  Publish a native session live (see below)
  agentlive watch <viewer-url>           Watch a recording in the terminal
  agentlive status [--stream <id>]       Show local publisher bindings (no content)
  agentlive pause --stream <id>          Stop capturing and delivering for a binding
  agentlive resume --stream <id>         Re-enable a paused binding
  agentlive finish --stream <id>         Deliver captured events and end the recording
  agentlive reopen --stream <id>         Reopen a recording finished by this binding
  agentlive retire --stream <id>         Set a finished binding aside; the next publish starts a new recording
  agentlive doctor [--server <origin>]   Check runtime, credentials, server and agents

Commands:
  agentlive finish-publisher --source <binding-directory> --operation-id <id>
  agentlive migrate-recording --source <binding-directory> --operation-id <id> --target-server <url> --target-owner-file <file> --old-recording retain|remove
  agentlive migrate-import --source <binding-directory> --native-source <file> --operation-id <id> --expected-manifest-hash <hash> --old-recording retain|remove [--confirm-removal] [--redact-env <name>]
  agentlive migrate-live --stream <id> | --source <binding-directory> --native-source <file> --operation-id <id> --expected-manifest-hash <hash> --old-recording retain|remove [--confirm-removal] [--title <text>] [--redact-env <name>] [--artifact-root <path>] [--artifact-base <path>]
  agentlive relocate-import-sources --source <binding-directory> --native-source <file> --family-source <child-id=path> --operation-id <id> --expected-manifest-hash <hash>
  agentlive inspect-migration --source <publisher-binding-directory> [--native-source <file>] [--verify-family] [--family-source <child-id=path>]
  agentlive reports [--server <origin>] [--limit 50] [--after <report-id>]
  agentlive accounts [--server <origin>] [--limit 50] [--after <account-id>]
  agentlive account-status --account-id <id> --action <disable|enable> --expected-version <version> [--server <origin>]
  agentlive review-report --report-id <id> --action <dismiss|remove> --revision <revision> --operation-id <unique-id> --note <reason> [--confirm-removal] [--server <origin>]
  agentlive discover --agent <codex|claude|kimi> [--source-root <directory>] [--limit 50]
  agentlive discover --agent opencode --native-server <origin> [--limit 50]
  agentlive discover --agent opencode --native-server <origin> --parent-session <id> [--limit 50]
  agentlive export --stream <recording-id> --output <recording.agentlive> [--server <origin>] [--anonymous]
  agentlive remove --stream <id> --revision <revision> --operation-id <unique-id> --confirm-removal [--server <origin>]
  agentlive list [--server <origin>] [--limit 50] [--after <recording-id>]
  agentlive visibility --stream <id> [--visibility public|unlisted|private] [--server <origin>]
  agentlive viewing-grant --stream <id> --expires-at <ISO-8601> [--label <name>] [--server <origin>]
  agentlive viewing-grants --stream <id> [--server <origin>]
  agentlive revoke-viewing-grant --stream <id> --grant-id <id> [--server <origin>]
  agentlive recover-publisher --source <publisher-binding-directory>
  agentlive rotate-publisher-credential --source <publisher-binding-directory> [--restart-rotation]
  agentlive publisher-credential --stream <recording-id> [--server <origin>]
  agentlive revoke-publisher-credential --stream <recording-id> --revision <revision> --expected-version <version> --operation-id <unique-id> [--server <origin>]
  agentlive restore --source <backup-directory> --output <new-state-directory>
  agentlive backup --output <new-backup-directory> [--state-dir <directory>] [--owner-file <file>]
  agentlive backup --output <new-server-host-directory> --server <origin> [--barrier-timeout-ms 30000] [--owner-file <file>]
  agentlive serve [--host 127.0.0.1] [--port 7331] [--max-cached-sessions 128] [--shutdown-timeout-ms 30000]
                  [--max-stored-bytes <n>] [--min-free-bytes <n>] [--no-snapshot-collection]
                  [--metrics]   (metrics token: AGENTLIVE_METRICS_TOKEN)
  agentlive import --agent <codex|claude|kimi|opencode> --source <file>
  agentlive import --agent <codex|claude|kimi> --native-session <id> [--source-root <directory>] [--native-agent <kimi-agent>]
  agentlive import --source <recording.agentlive> [--server <origin>]
  agentlive publish --agent <codex|claude|kimi> --source <file> [--record-format structured|legacy]
  agentlive publish --agent <codex|claude|kimi> --native-session <id> [--source-root <directory>] [--native-agent <kimi-agent>]
  agentlive publish --agent <codex|claude|kimi> --native-session <id> --launch [--cwd <project>] [--source-root <directory>]
  agentlive publish --agent <claude|codex|kimi> --launch [--cwd <project>] [--source-root <directory>]
  agentlive publish --agent opencode --launch [--native-session <id>] [--cwd <project>]
  agentlive publish --agent opencode --native-server <origin> --native-session <id> --include-children
  agentlive import --agent opencode --source <root-export.json> --source-root <exports-directory> --include-children
  agentlive import --agent codex --source <main-rollout> --source-root <rollouts-directory> --include-children
  agentlive import --agent claude --source <main-transcript.jsonl> --include-children
  agentlive import --agent kimi --source <session-dir>/agents/main/wire.jsonl --include-children
  agentlive publish --agent kimi --source <session-dir>/agents/main/wire.jsonl --include-children
  agentlive publish --agent claude --source <main-transcript.jsonl> --include-children
  agentlive publish --agent codex --native-session <id> --source-root <rollouts-directory> --include-children [--launch]
  agentlive publish --agent opencode --native-server <origin> --native-session <id> [--source <original-export> --resume-import]
  agentlive watch --stream <recording-id> [--server <origin>] [--anonymous] [--speed <factor>] [--idle-cap-ms <milliseconds>] [--interactive] [--resume-view | --restart-view] [--from-ms <position>] [--cancellation-timeout-ms 30000]
  agentlive replay --stream <recording-id> [--server <origin>] [--anonymous] [--speed <factor>] [--idle-cap-ms <milliseconds>] [--interactive] [--from-ms <position>]
  agentlive replay --source <recording.agentlive> [--speed <factor>] [--interactive] [--from-ms <position>]

Shared options:
  --state-dir <directory>  Persistent state (default: ~/.agentlive)
  --owner-file <file>      Owner credential JSON (default: <state-dir>/owner.json)
  --account-file <file>    Origin-bound hosted account credential from login

Hosted login:
  agentlive login --server <https-origin> --account-file <new-private-file>
  agentlive logout --server <https-origin> --account-file <private-file>
  --hosted-config <file>   Serve: OIDC configuration with environment secret names
  --viewer-file <file>     Issued viewing-grant JSON for watch/replay/export
  --help                  Show this help

Import options:
  --server <origin>       Server origin (default: http://127.0.0.1:7331)
  --target-server <url>   Migrate a frozen import to another server
  --target-owner-file <file> Destination operator credential (migration only)
  --target-account-file <file> Destination account credential bound to its origin
  --visibility <mode>     private (default), unlisted, or public
  --title <text>          Recording title
  --remote-artifact-policy <file>  Native import/publish: allowed origins and credential env names
  --artifact-bundles      Capture HTML artifacts with their supported dependencies
  --artifact-root <path>  Allowed local artifact root; repeat for multiple roots
  --artifact-base <path>  Base directory for relative artifact paths
  --redact-env <name>     Extra exact redaction value from this environment variable (publish, migrate-import, migrate-live)
  --expand-family        Expand a live recording to include children
  --resume-import        Continue an ended import with its original options
  --native-session <id>   Native session to select, or Kimi ID for a moved export
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
// A closed output pipe (e.g. `agentlive replay ... | head`) ends the command quietly.
let outputClosed = false;
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  outputClosed = true;
  controller.abort();
});
const secrets = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) &&
      value &&
      value.length >= 8 &&
      value.length <= 4096,
  )
  .map(([, value]) => value!);
/** Describe which viewer URLs actually reach a bound server; never call loopback public. */
function reachability(bound: string) {
  const url = new URL(bound);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || /^127\./.test(host) || host === "::1";
  const wildcard = host === "0.0.0.0" || host === "::";
  const format = (address: string, family: string) =>
    `http://${family === "IPv6" ? `[${address}]` : address}:${url.port}/`;
  const viewerUrls = wildcard
    ? [
        format("127.0.0.1", "IPv4"),
        ...Object.values(networkInterfaces())
          .flat()
          .filter(
            (entry) =>
              entry &&
              !entry.internal &&
              (host === "::" || entry.family === "IPv4") &&
              !entry.address.startsWith("fe80:"),
          )
          .map((entry) => format(entry!.address, entry!.family)),
      ]
    : [new URL("/", bound).toString()];
  return {
    viewerUrls,
    reachability: loopback ? "this-machine" : "network",
    note: loopback
      ? "Reachable only from this machine. Remote viewers need --host with an HTTPS reverse proxy or a tunnel."
      : "Reachable from networks that can route to these addresses over plain HTTP. Put an HTTPS reverse proxy in front for remote or public viewers.",
  };
}
/** Accept a browser viewer URL (`/?stream=<id>` or `/s/<id>`) as watch/replay arguments. */
function viewerArguments(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a viewer URL such as http://host/?stream=<id>");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Viewer URL must be http(s) without embedded credentials");
  const stream =
    url.searchParams.get("stream") ??
    /^\/s\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!stream) throw new Error("Viewer URL does not name a recording");
  return ["--server", url.origin, "--stream", decodeURIComponent(stream)];
}
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
  if (
    command !== "finish-publisher" &&
    command !== "status" &&
    command !== "pause" &&
    command !== "resume" &&
    command !== "finish" &&
    command !== "reopen" &&
    command !== "retire" &&
    command !== "doctor" &&
    command !== "migrate-recording" &&
    command !== "migrate-import" &&
    command !== "migrate-live" &&
    command !== "relocate-import-sources" &&
    command !== "inspect-migration" &&
    command !== "reports" &&
    command !== "accounts" &&
    command !== "account-status" &&
    command !== "review-report" &&
    command !== "login" &&
    command !== "logout" &&
    command !== "viewing-grant" &&
    command !== "viewing-grants" &&
    command !== "revoke-viewing-grant" &&
    command !== "recover-publisher" &&
    command !== "rotate-publisher-credential" &&
    command !== "publisher-credential" &&
    command !== "revoke-publisher-credential" &&
    command !== "restore" &&
    command !== "backup" &&
    command !== "list" &&
    command !== "visibility" &&
    command !== "discover" &&
    command !== "export" &&
    command !== "serve" &&
    command !== "import" &&
    command !== "remove" &&
    command !== "replay" &&
    command !== "publish" &&
    command !== "watch"
  )
    throw new Error("Unknown command; use agentlive --help");
  if (
    (command === "watch" || command === "replay") &&
    args[0] !== undefined &&
    !args[0].startsWith("-")
  )
    args.splice(0, 1, ...viewerArguments(args[0]));
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      launch: { type: "boolean" },
      "include-children": { type: "boolean" },
      "expand-family": { type: "boolean" },
      cwd: { type: "string" },
      limit: { type: "string" },
      after: { type: "string" },
      label: { type: "string" },
      "expires-at": { type: "string" },
      "grant-id": { type: "string" },
      "account-id": { type: "string" },
      "operation-id": { type: "string" },
      "expected-version": { type: "string" },
      revision: { type: "string" },
      "report-id": { type: "string" },
      action: { type: "string" },
      note: { type: "string" },
      "confirm-removal": { type: "boolean" },
      speed: { type: "string" },
      "idle-cap-ms": { type: "string" },
      "from-ms": { type: "string" },
      interactive: { type: "boolean" },
      "resume-view": { type: "boolean" },
      "restart-view": { type: "boolean" },
      "restart-rotation": { type: "boolean" },
      "resume-import": { type: "boolean" },
      "record-format": { type: "string" },
      stream: { type: "string" },
      output: { type: "string" },
      "barrier-timeout-ms": { type: "string" },
      anonymous: { type: "boolean" },
      "state-dir": { type: "string" },
      "owner-file": { type: "string" },
      "account-file": { type: "string" },
      "hosted-config": { type: "string" },
      "viewer-file": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "max-cached-sessions": { type: "string" },
      "shutdown-timeout-ms": { type: "string" },
      "max-stored-bytes": { type: "string" },
      "min-free-bytes": { type: "string" },
      "no-snapshot-collection": { type: "boolean" },
      metrics: { type: "boolean" },
      "cancellation-timeout-ms": { type: "string" },
      agent: { type: "string" },
      source: { type: "string" },
      "native-source": { type: "string" },
      "old-recording": { type: "string" },
      "redact-env": { type: "string", multiple: true },
      "verify-family": { type: "boolean" },
      "expected-manifest-hash": { type: "string" },
      "family-source": { type: "string", multiple: true },
      "source-root": { type: "string" },
      server: { type: "string" },
      "target-server": { type: "string" },
      "target-owner-file": { type: "string" },
      "target-account-file": { type: "string" },
      visibility: { type: "string" },
      title: { type: "string" },
      "remote-artifact-policy": { type: "string" },
      "artifact-bundles": { type: "boolean" },
      "artifact-root": { type: "string", multiple: true },
      "artifact-base": { type: "string" },
      "native-server": { type: "string" },
      "native-session": { type: "string" },
      "parent-session": { type: "string" },
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
    ...([
      "login",
      "migrate-import",
      "migrate-live",
      "finish-publisher",
      "migrate-recording",
      "remove",
      "logout",
      "list",
      "visibility",
      "import",
      "publish",
      "watch",
      "replay",
      "export",
      "viewing-grant",
      "viewing-grants",
      "revoke-viewing-grant",
      "publisher-credential",
      "revoke-publisher-credential",
    ].includes(command)
      ? ["account-file"]
      : []),
    ...(command === "accounts" ? ["server", "limit", "after"] : []),
    ...(command === "account-status"
      ? ["server", "account-id", "action", "expected-version"]
      : []),
    ...(command === "reports"
      ? ["server", "limit", "after"]
      : command === "review-report"
        ? [
            "server",
            "report-id",
            "action",
            "revision",
            "operation-id",
            "note",
            "confirm-removal",
          ]
        : []),
    ...(command === "finish-publisher"
      ? ["source", "operation-id", "server"]
      : []),
    ...(command === "status" ? ["stream"] : []),
    ...(["pause", "resume", "finish", "reopen", "retire"].includes(command)
      ? ["stream", "source"]
      : []),
    ...(command === "finish" ? ["account-file", "server"] : []),
    ...(command === "doctor" ? ["server"] : []),
    ...(command === "migrate-recording"
      ? [
          "source",
          "operation-id",
          "server",
          "target-server",
          "target-owner-file",
          "target-account-file",
          "old-recording",
          "confirm-removal",
        ]
      : []),
    ...(command === "migrate-import"
      ? [
          "source",
          "native-source",
          "operation-id",
          "expected-manifest-hash",
          "server",
          "target-server",
          "target-owner-file",
          "target-account-file",
          "old-recording",
          "confirm-removal",
          "redact-env",
          "source-root",
          "artifact-root",
          "artifact-base",
          "artifact-bundles",
          "remote-artifact-policy",
        ]
      : []),
    ...(command === "migrate-live"
      ? [
          "stream",
          "source",
          "native-source",
          "operation-id",
          "expected-manifest-hash",
          "server",
          "old-recording",
          "confirm-removal",
          "redact-env",
          "title",
          "artifact-root",
          "artifact-base",
          "artifact-bundles",
          "remote-artifact-policy",
        ]
      : []),
    ...(command === "relocate-import-sources"
      ? [
          "source",
          "native-source",
          "family-source",
          "operation-id",
          "expected-manifest-hash",
          "source-root",
        ]
      : []),
    ...(command === "remove"
      ? ["server", "stream", "revision", "operation-id", "confirm-removal"]
      : []),
    ...(["publisher-credential", "revoke-publisher-credential"].includes(
      command,
    )
      ? [
          "server",
          "stream",
          ...(command === "revoke-publisher-credential"
            ? ["revision", "expected-version", "operation-id"]
            : []),
        ]
      : []),
    ...(["viewing-grant", "viewing-grants", "revoke-viewing-grant"].includes(
      command,
    )
      ? [
          "server",
          "stream",
          ...(command === "viewing-grant"
            ? ["label", "expires-at"]
            : command === "revoke-viewing-grant"
              ? ["grant-id"]
              : []),
        ]
      : command === "login" || command === "logout"
        ? ["server"]
        : command === "finish-publisher" ||
            command === "status" ||
            command === "pause" ||
            command === "resume" ||
            command === "finish" ||
            command === "reopen" ||
            command === "retire" ||
            command === "doctor" ||
            command === "migrate-recording" ||
            command === "migrate-import" ||
            command === "migrate-live" ||
            command === "relocate-import-sources" ||
            command === "reports" ||
            command === "accounts" ||
            command === "account-status" ||
            command === "review-report" ||
            command === "remove" ||
            command === "publisher-credential" ||
            command === "revoke-publisher-credential"
          ? []
          : command === "discover"
            ? [
                "agent",
                "source-root",
                "native-server",
                "limit",
                "parent-session",
              ]
            : command === "export"
              ? ["server", "stream", "output", "anonymous", "viewer-file"]
              : command === "visibility"
                ? ["server", "stream", "visibility"]
                : command === "list"
                  ? ["server", "limit", "after"]
                  : command === "inspect-migration" ||
                      command === "recover-publisher" ||
                      command === "rotate-publisher-credential"
                    ? [
                        "source",
                        ...(command === "inspect-migration"
                          ? ["native-source", "verify-family", "family-source"]
                          : []),
                        ...(command === "rotate-publisher-credential"
                          ? ["restart-rotation"]
                          : []),
                      ]
                    : command === "restore"
                      ? ["source", "output"]
                      : command === "backup"
                        ? ["output", "server", "barrier-timeout-ms"]
                        : command === "serve"
                          ? [
                              "host",
                              "hosted-config",
                              "port",
                              "max-cached-sessions",
                              "shutdown-timeout-ms",
                              "max-stored-bytes",
                              "min-free-bytes",
                              "no-snapshot-collection",
                              "metrics",
                            ]
                          : command === "replay" || command === "watch"
                            ? [
                                "server",
                                "stream",
                                "anonymous",
                                "viewer-file",
                                "idle-cap-ms",
                                ...(command === "replay"
                                  ? [
                                      "speed",
                                      "interactive",
                                      "from-ms",
                                      "source",
                                    ]
                                  : [
                                      "speed",
                                      "interactive",
                                      "from-ms",
                                      "resume-view",
                                      "restart-view",
                                      "cancellation-timeout-ms",
                                    ]),
                              ]
                            : [
                                ...(command === "publish"
                                  ? [
                                      "record-format",
                                      "resume-import",
                                      "expand-family",
                                      "native-server",
                                      "launch",
                                      "cwd",
                                      "redact-env",
                                    ]
                                  : []),
                                "include-children",
                                "agent",
                                "source",
                                "source-root",
                                "server",
                                "visibility",
                                "title",
                                "remote-artifact-policy",
                                "artifact-bundles",
                                "artifact-root",
                                "artifact-base",
                                "native-session",
                                "native-agent",
                              ]),
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key)))
    throw new Error("Option does not apply to this command; use --help");
  // Explicit extra redaction values (migrate-import, migrate-live and publish continuation).
  for (const name of values["redact-env"] ?? []) {
    const value = process.env[name];
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !value ||
      value.length < 8 ||
      value.length > 4096
    )
      throw new Error(
        "Redaction environment variable must contain 8 to 4096 characters",
      );
    secrets.push(value);
  }
  if (
    values["remote-artifact-policy"] &&
    command !== "migrate-import" &&
    command !== "migrate-live" &&
    values.agent !== "opencode" &&
    values.agent !== "claude" &&
    values.agent !== "kimi" &&
    values.agent !== "codex"
  )
    throw new Error(
      "--remote-artifact-policy currently requires a supported native agent",
    );
  const remoteArtifacts = values["remote-artifact-policy"]
    ? await loadRemoteArtifactPolicy(resolve(values["remote-artifact-policy"]))
    : undefined;
  if (remoteArtifacts)
    secrets.push(
      ...remoteArtifacts.origins.flatMap((entry) =>
        entry.authorization ? [entry.authorization] : [],
      ),
    );
  if (
    values["expand-family"] &&
    (!values["include-children"] || values["resume-import"] || values.launch)
  )
    throw new Error(
      "--expand-family requires publishing with --include-children, without --resume-import or --launch",
    );
  if (values.cwd && !values.launch) throw new Error("--cwd requires --launch");
  if (
    values["include-children"] &&
    values.agent !== "opencode" &&
    values.agent !== "kimi" &&
    values.agent !== "claude" &&
    values.agent !== "codex"
  )
    throw new Error("--include-children requires a supported native agent");
  if (
    values.launch &&
    (values.source ||
      (!values["native-session"] &&
        values.agent !== "claude" &&
        values.agent !== "codex" &&
        values.agent !== "kimi" &&
        values.agent !== "opencode") ||
      !["codex", "claude", "kimi", "opencode"].includes(values.agent ?? ""))
  )
    throw new Error(
      "--launch requires a file agent and --native-session selected through discovery",
    );
  if (
    values.launch &&
    values.agent === "kimi" &&
    values["native-agent"] &&
    values["native-agent"] !== "main"
  )
    throw new Error("Managed Kimi resume requires the main agent log");
  const stateDir = resolve(
    values["state-dir"] ?? join(homedir(), ".agentlive"),
  );
  if (
    values["viewer-file"] &&
    (values["owner-file"] || values.anonymous || values.source)
  )
    throw new Error(
      "--viewer-file cannot be combined with --owner-file, --anonymous or --source",
    );
  const ownerFile = resolve(
    values["owner-file"] ?? join(stateDir, "owner.json"),
  );
  if (
    values["account-file"] &&
    (values["owner-file"] ||
      values["viewer-file"] ||
      values.anonymous ||
      (command === "replay" && values.source))
  )
    throw new Error(
      "--account-file cannot be combined with owner/viewer credentials, anonymous access or offline replay",
    );
  const loadCredential = async () => {
    if (values["account-file"])
      return accountCredential(
        resolve(values["account-file"]),
        values.server ?? "http://127.0.0.1:7331",
      );
    return process.env.AGENTLIVE_OWNER_SECRET
      ? validateSecret(process.env.AGENTLIVE_OWNER_SECRET)
      : ownerCredential(ownerFile, false);
  };
  if (command === "login" || command === "logout") {
    if (!values.server || !values["account-file"] || values["owner-file"])
      throw new Error(
        "Login/logout require --server <https-origin> and --account-file <private-file>",
      );
    const result =
      command === "login"
        ? await loginAccount({
            serverOrigin: values.server,
            output: resolve(values["account-file"]),
            signal: controller.signal,
            prompt: ({ userCode, verificationUri }) =>
              process.stderr.write(
                `Open ${verificationUri}\nEnter device code: ${userCode}\nApprove only this login in your own browser.\n`,
              ),
          })
        : await logoutAccount({
            serverOrigin: values.server,
            path: resolve(values["account-file"]),
            signal: controller.signal,
          });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "publish" && values.launch && values.agent === "opencode") {
    if (
      values["native-server"] ||
      values["source-root"] ||
      values["native-agent"] ||
      values["resume-import"] ||
      values["record-format"] ||
      values["artifact-base"]
    )
      throw new Error(
        "Managed OpenCode launch cannot use external-source or import-resume options",
      );
    const visibility = values.visibility ?? "private";
    if (
      visibility !== "private" &&
      visibility !== "public" &&
      visibility !== "unlisted"
    )
      throw new Error("Visibility must be private, unlisted, or public");
    const secret = await loadCredential();
    secrets.push(secret);
    const output = (event: object) => {
      process.stderr.write(JSON.stringify(event) + "\n");
    };
    const code = await launchManagedOpenCode({
      ...(remoteArtifacts ? { remoteArtifacts } : {}),
      ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
      includeChildren: values["include-children"] ?? false,
      stateDir,
      cwd: resolve(values.cwd ?? process.cwd()),
      publisherRoot: join(stateDir, "publisher"),
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      ownerCredential: secret,
      ...(values["native-session"]
        ? { nativeSessionId: values["native-session"] }
        : {}),
      ...(values["artifact-root"]
        ? { artifactRoots: values["artifact-root"] }
        : {}),
      title: values.title ?? "Live opencode session",
      visibility,
      secrets,
      signal: controller.signal,
      onReady: (recording) =>
        output({
          event: "publishing",
          ...recording,
          viewerUrl: viewerUrl(
            values.server ?? "http://127.0.0.1:7331",
            recording.streamId,
          ),
        }),
      onStatus: (status) => output({ event: "publisher-status", status }),
      onLaunch: (event) => output({ event: "managed-launch", ...event }),
    });
    if (code) throw new Error(`Native agent exited with status ${code}`);
    return;
  }
  if (
    command === "publish" &&
    values.launch &&
    (values.agent === "claude" ||
      values.agent === "codex" ||
      values.agent === "kimi") &&
    !values["native-session"]
  ) {
    if (
      values["resume-import"] ||
      values["native-agent"] ||
      values["native-server"] ||
      values["record-format"]
    )
      throw new Error("Fresh launch cannot use resume or other-agent options");
    const visibility = values.visibility ?? "private";
    if (
      visibility !== "private" &&
      visibility !== "public" &&
      visibility !== "unlisted"
    )
      throw new Error("Visibility must be private, unlisted, or public");
    const secret = await loadCredential();
    secrets.push(secret);
    const output = (event: object) => {
      process.stderr.write(JSON.stringify(event) + "\n");
    };
    const code = await (
      values.agent === "codex"
        ? launchNewCodex
        : values.agent === "kimi"
          ? launchNewKimi
          : launchNewClaude
    )({
      ...(remoteArtifacts ? { remoteArtifacts } : {}),
      ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
      includeChildren: values["include-children"] ?? false,
      stateDir,
      publisherRoot: join(stateDir, "publisher"),
      sourceRoot: resolve(
        values["source-root"] ??
          (values.agent === "codex"
            ? join(
                process.env.CODEX_HOME ?? join(homedir(), ".codex"),
                "sessions",
              )
            : values.agent === "kimi"
              ? join(homedir(), ".kimi-code", "sessions")
              : join(
                  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
                  "projects",
                )),
      ),
      cwd: resolve(values.cwd ?? process.cwd()),
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      ownerCredential: secret,
      title: values.title ?? `Live ${values.agent} session`,
      visibility,
      secrets,
      signal: controller.signal,
      ...(values["artifact-root"]
        ? { artifactRoots: values["artifact-root"] }
        : {}),
      ...(values["artifact-base"]
        ? { artifactBaseDirectory: values["artifact-base"] }
        : {}),
      onReady: (recording) =>
        output({
          event: "publishing",
          ...recording,
          viewerUrl: viewerUrl(
            values.server ?? "http://127.0.0.1:7331",
            recording.streamId,
          ),
        }),
      onStatus: (status) => output({ event: "publisher-status", status }),
      onLaunch: (event) => output({ event: "managed-launch", ...event }),
    });
    if (code) throw new Error(`Native agent exited with status ${code}`);
    return;
  }
  if (
    ["viewing-grant", "viewing-grants", "revoke-viewing-grant"].includes(
      command,
    )
  ) {
    if (!values.stream)
      throw new Error("Viewing credential management requires --stream");
    if (
      command === "viewing-grant" &&
      (!values["expires-at"] ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
          values["expires-at"],
        ))
    )
      throw new Error(
        "Issuance requires --expires-at with an ISO-8601 timestamp and timezone",
      );
    if (command === "revoke-viewing-grant" && !values["grant-id"])
      throw new Error("Revocation requires --grant-id");
    const credential = await loadCredential();
    secrets.push(credential);
    const result = await manageViewingGrants({
      action:
        command === "viewing-grant"
          ? "issue"
          : command === "viewing-grants"
            ? "list"
            : "revoke",
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      streamId: values.stream,
      credential,
      signal: controller.signal,
      ...(values.label === undefined ? {} : { label: values.label }),
      ...(values["expires-at"] === undefined
        ? {}
        : { expiresAt: Date.parse(values["expires-at"]) }),
      ...(values["grant-id"] === undefined
        ? {}
        : { grantId: values["grant-id"] }),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const publisherRoot = join(stateDir, "publisher");
  const bindingDirectory = async () => {
    if (!!values.stream === !!values.source)
      throw new Error(
        "Select a binding with exactly one of --stream <recording-id> or --source <binding-directory>",
      );
    return values.source
      ? resolve(values.source)
      : findBinding({
          publisherRoot,
          streamId: values.stream!,
          signal: controller.signal,
        });
  };
  if (command === "status") {
    const bindings = await publisherStatus({
      publisherRoot,
      ...(values.stream ? { streamId: values.stream } : {}),
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify({ bindings }) + "\n");
    return;
  }
  if (command === "pause" || command === "resume") {
    const result = await setPublisherSharing({
      directory: await bindingDirectory(),
      enabled: command === "resume",
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "finish") {
    const directory = await bindingDirectory();
    const credential = await loadCredential();
    secrets.push(credential);
    const result = await finishBinding({
      directory,
      ownerCredential: credential,
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "reopen") {
    const result = await reopenBinding({
      directory: await bindingDirectory(),
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "accounts" || command === "account-status") {
    const credential = await loadCredential();
    secrets.push(credential);
    const serverOrigin = values.server ?? "http://127.0.0.1:7331";
    if (command === "accounts") {
      const page = await listAccounts({
        serverOrigin,
        credential,
        signal: controller.signal,
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      });
      process.stdout.write(JSON.stringify(page) + "\n");
      return;
    }
    const expectedVersion = Number(values["expected-version"]);
    if (
      !values["account-id"] ||
      (values.action !== "disable" && values.action !== "enable") ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    )
      throw new Error(
        "account-status requires --account-id, --action disable|enable and --expected-version",
      );
    const account = await setAccountDisabled({
      serverOrigin,
      credential,
      accountId: values["account-id"],
      expectedVersion,
      disabled: values.action === "disable",
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(account) + "\n");
    return;
  }
  if (command === "retire") {
    const result = await retireBinding({ directory: await bindingDirectory() });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "doctor") {
    const report = await doctor({
      stateDir,
      ownerFile,
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(report) + "\n");
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "finish-publisher" || command === "migrate-recording") {
    if (!values.source || !values["operation-id"])
      throw new Error("Command requires --source and --operation-id");
    const source = await inspectMigration(resolve(values.source));
    if (values.server && values.server !== source.serverOrigin)
      throw new Error("Source server differs from publisher binding");
    values.server = source.serverOrigin;
    const credential = await loadCredential();
    secrets.push(credential);
    if (command === "finish-publisher") {
      const result = await finishPublisher({
        directory: resolve(values.source),
        operationId: values["operation-id"],
        ownerCredential: credential,
        signal: controller.signal,
      });
      process.stdout.write(
        JSON.stringify({ event: "publisher-finished", ...result }) + "\n",
      );
      return;
    }
    if (
      !values["target-server"] ||
      !["retain", "remove"].includes(values["old-recording"] ?? "") ||
      Boolean(values["target-owner-file"]) ===
        Boolean(values["target-account-file"])
    )
      throw new Error(
        "Recording migration requires --target-server, one destination credential file and --old-recording retain|remove",
      );
    const targetCredential = values["target-account-file"]
      ? await accountCredential(
          resolve(values["target-account-file"]),
          values["target-server"],
        )
      : await ownerCredential(resolve(values["target-owner-file"]!), false);
    secrets.push(targetCredential);
    const result = await migrateRecording({
      directory: resolve(values.source),
      operationId: values["operation-id"],
      targetServerOrigin: values["target-server"],
      sourceCredential: credential,
      targetCredential,
      disposition: values["old-recording"] as "retain" | "remove",
      confirmRemoval: values["confirm-removal"] ?? false,
      signal: controller.signal,
    });
    process.stdout.write(
      JSON.stringify({ event: "recording-migrated", ...result }) + "\n",
    );
    return;
  }
  if (command === "migrate-import") {
    if (
      !values.source ||
      !values["native-source"] ||
      !values["operation-id"] ||
      !values["expected-manifest-hash"] ||
      !["retain", "remove"].includes(values["old-recording"] ?? "")
    )
      throw new Error(
        "Migration requires source, native-source, operation-id, expected-manifest-hash and --old-recording retain|remove",
      );
    const sourceBinding = await inspectMigration(resolve(values.source));
    if (values.server && values.server !== sourceBinding.serverOrigin)
      throw new Error(
        "Replacement migration currently requires the original server origin",
      );
    values.server = sourceBinding.serverOrigin;
    const credential = await loadCredential();
    secrets.push(credential);
    const targetServer = values["target-server"];
    if (
      Boolean(targetServer) !==
        Boolean(values["target-owner-file"] || values["target-account-file"]) ||
      (values["target-owner-file"] && values["target-account-file"])
    )
      throw new Error(
        "Select --target-server with exactly one of --target-owner-file or --target-account-file",
      );
    const targetCredential = values["target-account-file"]
      ? await accountCredential(
          resolve(values["target-account-file"]),
          targetServer!,
        )
      : values["target-owner-file"]
        ? await ownerCredential(resolve(values["target-owner-file"]), false)
        : undefined;
    if (targetCredential) secrets.push(targetCredential);
    const result = await migrateImport({
      directory: resolve(values.source),
      nativeSource: resolve(values["native-source"]),
      operationId: values["operation-id"],
      expectedManifestHash: values["expected-manifest-hash"],
      disposition: values["old-recording"] as "retain" | "remove",
      confirmRemoval: values["confirm-removal"] ?? false,
      ownerCredential: credential,
      ...(targetServer
        ? {
            targetServerOrigin: targetServer,
            targetOwnerCredential: targetCredential!,
          }
        : {}),
      secrets,
      signal: controller.signal,
      ...(values["source-root"]
        ? { sourceRoot: resolve(values["source-root"]) }
        : {}),
      ...(values["artifact-root"]
        ? { artifactRoots: values["artifact-root"] }
        : {}),
      ...(values["artifact-base"]
        ? { artifactBaseDirectory: values["artifact-base"] }
        : {}),
      ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
      ...(remoteArtifacts ? { remoteArtifacts } : {}),
    });
    process.stdout.write(
      JSON.stringify({ event: "import-migrated", ...result }) + "\n",
    );
    return;
  }
  if (command === "migrate-live") {
    if (
      !values["native-source"] ||
      !values["operation-id"] ||
      !values["expected-manifest-hash"] ||
      !["retain", "remove"].includes(values["old-recording"] ?? "") ||
      !!values.stream === !!values.source
    )
      throw new Error(
        "Live migration requires one of --stream or --source, --native-source, --operation-id, --expected-manifest-hash and --old-recording retain|remove",
      );
    const directory = values.source
      ? resolve(values.source)
      : await resolveLiveMigrationDirectory({
          publisherRoot,
          streamId: values.stream!,
          signal: controller.signal,
        });
    const serverOrigin = await liveMigrationServerOrigin(directory);
    if (values.server && values.server !== serverOrigin)
      throw new Error("Live migration uses the binding's server origin");
    values.server = serverOrigin;
    const credential = await loadCredential();
    secrets.push(credential);
    const result = await migrateLiveBinding({
      directory,
      nativeSource: resolve(values["native-source"]),
      operationId: values["operation-id"],
      expectedManifestHash: values["expected-manifest-hash"],
      disposition: values["old-recording"] as "retain" | "remove",
      confirmRemoval: values["confirm-removal"] ?? false,
      ...(values.stream ? { sourceStreamId: values.stream } : {}),
      ownerCredential: credential,
      secrets,
      signal: controller.signal,
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(values["artifact-root"]
        ? { artifactRoots: values["artifact-root"] }
        : {}),
      ...(values["artifact-base"]
        ? { artifactBaseDirectory: values["artifact-base"] }
        : {}),
      ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
      ...(remoteArtifacts ? { remoteArtifacts } : {}),
    });
    process.stdout.write(
      JSON.stringify({ event: "live-migrated", ...result }) + "\n",
    );
    return;
  }
  if (command === "relocate-import-sources") {
    if (
      !values.source ||
      !values["native-source"] ||
      !values["family-source"]?.length ||
      !values["operation-id"] ||
      !values["expected-manifest-hash"]
    )
      throw new Error(
        "Relocation requires --source, --native-source, --family-source, --operation-id and --expected-manifest-hash",
      );
    const result = await relocateImportSources(values.source, {
      nativeSource: values["native-source"],
      ...(values["source-root"] ? { sourceRoot: values["source-root"] } : {}),
      familySources: values["family-source"],
      operationId: values["operation-id"],
      expectedManifestHash: values["expected-manifest-hash"],
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "inspect-migration") {
    if (!values.source)
      throw new Error(
        "Migration inspection requires --source <publisher-binding-directory>",
      );
    process.stdout.write(
      JSON.stringify(
        await inspectMigration(values.source, {
          signal: controller.signal,
          ...(values["verify-family"] ? { verifyFamily: true } : {}),
          ...(values["family-source"]
            ? { familySources: values["family-source"] }
            : {}),
          ...(values["native-source"] === undefined
            ? {}
            : { nativeSource: values["native-source"] }),
        }),
      ) + "\n",
    );
    return;
  }
  if (command === "reports" || command === "review-report") {
    if (
      command === "reports" &&
      values.limit !== undefined &&
      !/^[1-9][0-9]*$/.test(values.limit)
    )
      throw new Error("Report limit must be from 1 to 100");
    if (
      command === "review-report" &&
      (!values["report-id"] ||
        !values.revision ||
        !values["operation-id"] ||
        !values.note?.trim() ||
        !["dismiss", "remove"].includes(values.action ?? ""))
    )
      throw new Error(
        "Review requires --report-id, --revision, --operation-id, --note and --action dismiss|remove",
      );
    if (
      command === "review-report" &&
      values.action === "remove" &&
      !values["confirm-removal"]
    )
      throw new Error(
        "A removal decision requires --confirm-removal; it permanently ends service access",
      );
    const credential = await loadCredential();
    secrets.push(credential);
    const options = {
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      credential,
      signal: controller.signal,
    };
    const result =
      command === "reports"
        ? await listReports({
            ...options,
            ...(values.after === undefined ? {} : { after: values.after }),
            ...(values.limit === undefined
              ? {}
              : { limit: Number(values.limit) }),
          })
        : await decideReport({
            ...options,
            reportId: values["report-id"]!,
            decision: {
              operationId: values["operation-id"]!,
              revision: values.revision!,
              action: values.action as "dismiss" | "remove",
              note: values.note!,
            },
          });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "remove") {
    if (
      !values.stream ||
      !values.revision ||
      !values["operation-id"] ||
      !values["confirm-removal"]
    )
      throw new Error(
        "Removal requires --stream, --revision, --operation-id and --confirm-removal. It ends service access and schedules recording data cleanup; removal metadata and existing copies are retained.",
      );
    const credential = await loadCredential();
    secrets.push(credential);
    const result = await removeRecording({
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      streamId: values.stream,
      revision: values.revision,
      operationId: values["operation-id"],
      credential,
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (
    [
      "publisher-credential",
      "revoke-publisher-credential",
      "rotate-publisher-credential",
    ].includes(command)
  ) {
    const credential = await loadCredential();
    secrets.push(credential);
    if (command === "rotate-publisher-credential") {
      if (!values.source)
        throw new Error(
          "Rotation requires --source <publisher-binding-directory>",
        );
      const result = await rotatePublisherCredential({
        directory: resolve(values.source),
        ownerCredential: credential,
        signal: controller.signal,
        ...(values["restart-rotation"] ? { restart: true } : {}),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      if (!values.stream)
        throw new Error("Publisher credential management requires --stream");
      if (
        command === "revoke-publisher-credential" &&
        (!values.revision ||
          !values["operation-id"] ||
          !/^(0|[1-9][0-9]*)$/.test(values["expected-version"] ?? ""))
      )
        throw new Error(
          "Revocation requires --revision, --expected-version and --operation-id; inspect publisher-credential first",
        );
      const result = await publisherCredential({
        serverOrigin: values.server ?? "http://127.0.0.1:7331",
        streamId: values.stream,
        credential,
        signal: controller.signal,
        ...(command === "revoke-publisher-credential"
          ? {
              revoke: {
                revision: values.revision!,
                expectedVersion: Number(values["expected-version"]),
                operationId: values["operation-id"]!,
              },
            }
          : {}),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    }
    return;
  }
  if (command === "recover-publisher") {
    if (!values.source)
      throw new Error(
        "Publisher recovery requires --source <publisher-binding-directory>",
      );
    const result = await recoverPublisher({
      directory: resolve(values.source),
      signal: controller.signal,
    });
    process.stdout.write(
      JSON.stringify({ event: "publisher-recovered", ...result }) + "\n",
    );
    return;
  }
  if (command === "restore") {
    if (!values.source || !values.output)
      throw new Error(
        "Restore requires --source <backup-directory> and --output <new-state-directory>",
      );
    const result = await restoreServer({
      source: resolve(values.source),
      output: resolve(values.output),
      signal: controller.signal,
    });
    process.stdout.write(
      JSON.stringify({ event: "restored", ...result }) + "\n",
    );
    return;
  }
  if (command === "backup") {
    if (!values.output)
      throw new Error("Backup requires --output <new-backup-directory>");
    if (values.server) {
      // Online: the running server writes the backup on its own host.
      const barrierTimeoutMs =
        values["barrier-timeout-ms"] === undefined
          ? undefined
          : Number(values["barrier-timeout-ms"]);
      if (
        barrierTimeoutMs !== undefined &&
        (!/^[1-9][0-9]*$/.test(values["barrier-timeout-ms"]!) ||
          barrierTimeoutMs < 1000 ||
          barrierTimeoutMs > 600_000)
      )
        throw new Error("--barrier-timeout-ms must be from 1000 to 600000");
      const credential = await loadCredential();
      secrets.push(credential);
      const result = await requestOnlineBackup({
        serverOrigin: values.server,
        credential,
        output: resolve(values.output),
        ...(barrierTimeoutMs === undefined ? {} : { barrierTimeoutMs }),
        signal: controller.signal,
        onProgress: (event) => {
          if (event.event === "progress")
            process.stderr.write(
              JSON.stringify({ event: "backup-progress", phase: event.phase }) +
                "\n",
            );
        },
      });
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    if (values["barrier-timeout-ms"] !== undefined)
      throw new Error("--barrier-timeout-ms requires --server <origin>");
    if (process.env.AGENTLIVE_OWNER_SECRET)
      throw new Error(
        "Backup requires the persisted owner credential file; environment-only credentials must be preserved separately",
      );
    const result = await backupServer({
      directory: join(stateDir, "server"),
      ownerFile,
      output: resolve(values.output),
      signal: controller.signal,
    }).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "publisher_busy")
        throw new Error(
          "The server data directory is in use by a running server; stop it for an offline backup or run an online backup with --server <origin>",
        );
      throw error;
    });
    process.stdout.write(JSON.stringify({ event: "backup", ...result }) + "\n");
    return;
  }
  if (command === "serve") {
    const maxCachedSessions = Number(values["max-cached-sessions"] ?? 128);
    if (!Number.isSafeInteger(maxCachedSessions) || maxCachedSessions < 1)
      throw new Error("--max-cached-sessions must be a positive integer");
    const shutdownTimeoutMs = Number(values["shutdown-timeout-ms"] ?? 30_000);
    if (
      !Number.isSafeInteger(shutdownTimeoutMs) ||
      shutdownTimeoutMs < 1 ||
      shutdownTimeoutMs > 2_147_483_647
    )
      throw new Error(
        "--shutdown-timeout-ms must be an integer from 1 to 2147483647",
      );
    const port = Number(values.port ?? 7331);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error("Port must be an integer from 0 to 65535");
    const secret = process.env.AGENTLIVE_OWNER_SECRET
      ? validateSecret(process.env.AGENTLIVE_OWNER_SECRET)
      : await ownerCredential(ownerFile, true);
    secrets.push(secret);
    const hosted = values["hosted-config"]
      ? await loadHostedConfig(resolve(values["hosted-config"]))
      : undefined;
    if (hosted)
      secrets.push(hosted.hosted.clientSecret, hosted.hosted.cookiePassword);
    const storage: { maxStoredBytes?: number; minFreeBytes?: number } = {};
    for (const [flag, key] of [
      ["max-stored-bytes", "maxStoredBytes"],
      ["min-free-bytes", "minFreeBytes"],
    ] as const) {
      const raw = values[flag];
      if (raw === undefined) continue;
      if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new Error(`--${flag} must be a nonnegative integer byte count`);
      storage[key] = Number(raw);
    }
    const metricsToken = process.env.AGENTLIVE_METRICS_TOKEN || undefined;
    if (metricsToken) secrets.push(metricsToken);
    const server = await startServer({
      ...hosted,
      storage,
      ...(values.metrics
        ? { metrics: metricsToken ? { token: metricsToken } : {} }
        : {}),
      directory: join(stateDir, "server"),
      ownerSecret: secret,
      host: values.host ?? "127.0.0.1",
      ...(values["no-snapshot-collection"]
        ? { snapshots: { collect: false } }
        : {}),
      maxCachedSessions,
      shutdownTimeoutMs,
      port,
    });
    try {
      process.stdout.write(
        JSON.stringify({
          event: "ready",
          url: server.url,
          ...reachability(server.url),
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
  if (command === "visibility") {
    if (!values.stream)
      throw new Error("Visibility requires --stream <recording-id>");
    const credential = await loadCredential();
    secrets.push(credential);
    const common = {
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      streamId: values.stream,
      credential,
      signal: controller.signal,
    };
    const current = await readVisibility(common);
    if (values.visibility === undefined) {
      process.stdout.write(JSON.stringify(current) + "\n");
      return;
    }
    if (!["public", "unlisted", "private"].includes(values.visibility))
      throw new Error("--visibility must be private, unlisted or public");
    const requested = values.visibility as "public" | "unlisted" | "private";
    // A stable operation ID makes an interrupted change safe to repeat, and the
    // observed version rejects a concurrent change instead of overwriting it.
    const result =
      current.visibility === requested
        ? current
        : await changeVisibility({
            ...common,
            revision: current.revision,
            expectedVersion: current.version,
            operationId: createHash("sha256")
              .update(
                canonicalJson({
                  operation: "cli-visibility",
                  streamId: current.streamId,
                  revision: current.revision,
                  version: current.version,
                  visibility: requested,
                }),
              )
              .digest("hex"),
            visibility: requested,
          });
    process.stdout.write(
      JSON.stringify({ ...result, changed: current.visibility !== requested }) +
        "\n",
    );
    return;
  }
  if (command === "list") {
    const credential = await loadCredential();
    secrets.push(credential);
    const page = await listRecordings({
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      credential,
      signal: controller.signal,
      ...(values.after === undefined ? {} : { after: values.after }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    });
    process.stdout.write(JSON.stringify(page) + "\n");
    return;
  }
  if (command === "discover") {
    const agent = values.agent;
    if (
      agent !== "codex" &&
      agent !== "claude" &&
      agent !== "kimi" &&
      agent !== "opencode"
    )
      throw new Error(
        "Discovery requires --agent codex, claude, kimi or opencode",
      );
    const defaults = {
      codex: join(
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        "sessions",
      ),
      claude: join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      ),
      kimi: join(homedir(), ".kimi-code", "sessions"),
    };
    const result = await discoverNativeSessions({
      agent,
      ...(values["parent-session"]
        ? { parentNativeSessionId: values["parent-session"] }
        : {}),
      signal: controller.signal,
      ...(agent === "opencode"
        ? {}
        : { root: values["source-root"] ?? defaults[agent] }),
      ...(values["native-server"]
        ? { nativeServer: values["native-server"] }
        : {}),
      ...(agent === "opencode" && values["source-root"]
        ? { root: values["source-root"] }
        : {}),
      ...(process.env.OPENCODE_SERVER_PASSWORD
        ? { password: process.env.OPENCODE_SERVER_PASSWORD }
        : {}),
      ...(process.env.OPENCODE_SERVER_USERNAME
        ? { username: process.env.OPENCODE_SERVER_USERNAME }
        : {}),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "import" && !values.agent) {
    if (!values.source) throw new Error("Archive import requires --source");
    if (
      Object.keys(values).some(
        (key) =>
          ![
            "source",
            "server",
            "state-dir",
            "owner-file",
            "account-file",
          ].includes(key),
      )
    )
      throw new Error(
        "Archive import accepts source, server and owner credential options only; recordings import privately",
      );
    const credential = await loadCredential();
    secrets.push(credential);
    const result = await importArchiveRecording({
      source: resolve(values.source),
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      credential,
      signal: controller.signal,
    });
    process.stdout.write(
      JSON.stringify({
        event: "imported",
        format: "agentlive.recording",
        ...result,
      }) + "\n",
    );
    return;
  }
  if (command === "export") {
    if (!values.stream || !values.output)
      throw new Error("Export requires --stream and --output");
    const credential = values.anonymous
      ? undefined
      : values["viewer-file"]
        ? await viewingCredential(resolve(values["viewer-file"]), values.stream)
        : await loadCredential();
    if (credential) secrets.push(credential);
    const result = await exportRecording({
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      streamId: values.stream,
      output: resolve(values.output),
      signal: controller.signal,
      ...(credential ? { credential } : {}),
    });
    process.stdout.write(
      JSON.stringify({ event: "exported", ...result }) + "\n",
    );
    return;
  }
  if (command === "replay" || command === "watch") {
    if (
      values.source &&
      (command !== "replay" ||
        values.stream ||
        values.server ||
        values.anonymous)
    )
      throw new Error(
        "Archive replay accepts --source without server, stream or anonymous options",
      );
    if (!values.stream && !values.source)
      throw new Error("Replay and watch require --stream <recording-id>");
    const fromMs =
      values["from-ms"] === undefined ? undefined : Number(values["from-ms"]);
    if (fromMs !== undefined && (!Number.isFinite(fromMs) || fromMs < 0))
      throw new Error("--from-ms must be a nonnegative finite number");
    const idleCapMs =
      values["idle-cap-ms"] === undefined
        ? undefined
        : values["idle-cap-ms"] === "off"
          ? null
          : Number(values["idle-cap-ms"]);
    if (
      idleCapMs !== undefined &&
      idleCapMs !== null &&
      (!Number.isFinite(idleCapMs) || idleCapMs < 0)
    )
      throw new Error(
        "--idle-cap-ms must be a nonnegative finite number or off",
      );
    const speed = values.speed === undefined ? undefined : Number(values.speed);
    if (
      speed !== undefined &&
      (!Number.isFinite(speed) || speed <= 0 || speed > 1024)
    )
      throw new Error("--speed must be greater than zero and at most 1024");
    const credential =
      values.anonymous || values.source
        ? undefined
        : values["viewer-file"]
          ? await viewingCredential(
              resolve(values["viewer-file"]),
              values.stream!,
            )
          : await loadCredential();
    if (credential) secrets.push(credential);
    await (command === "watch" ? watchRecording : replayRecording)({
      ...(values.source ? { archivePath: resolve(values.source) } : {}),
      cacheRoot: join(stateDir, "subscriber"),
      ...(values["cancellation-timeout-ms"] === undefined
        ? {}
        : { cancellationTimeoutMs: Number(values["cancellation-timeout-ms"]) }),
      ...(speed === undefined ? {} : { speed }),
      ...(idleCapMs === undefined ? {} : { idleCapMs }),
      ...(fromMs === undefined ? {} : { fromMs }),
      ...(values.interactive ? { interactive: true } : {}),
      ...(values["resume-view"] ? { resumeView: true } : {}),
      ...(values["restart-view"] ? { restartView: true } : {}),
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      streamId: values.stream ?? "archive",
      ...(credential ? { credential } : {}),
      signal: controller.signal,
    });
    return;
  }
  if (command === "publish" && values.agent === "opencode") {
    if (!values["native-server"] || !values["native-session"])
      throw new Error(
        "OpenCode publishing requires --native-server and --native-session",
      );
    if (
      values["native-agent"] ||
      values["source-root"] ||
      values["record-format"] ||
      values["artifact-base"]
    )
      throw new Error(
        "OpenCode server publishing does not accept file import or conversion options",
      );
    const visibility = values.visibility ?? "private";
    if (
      visibility !== "private" &&
      visibility !== "public" &&
      visibility !== "unlisted"
    )
      throw new Error("Visibility must be private, unlisted, or public");
    const secret = await loadCredential();
    secrets.push(secret);
    await publishOpenCodeRecording({
      ...(remoteArtifacts ? { remoteArtifacts } : {}),
      ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
      includeChildren: values["include-children"] ?? false,
      expandFamily: values["expand-family"] ?? false,
      ...(values["artifact-root"]
        ? { artifactRoots: values["artifact-root"] }
        : {}),
      ...(values.source ? { sourcePath: resolve(values.source) } : {}),
      resumeImport: values["resume-import"] ?? false,
      publisherRoot: join(stateDir, "publisher"),
      serverOrigin: values.server ?? "http://127.0.0.1:7331",
      ownerCredential: secret,
      nativeServerOrigin: values["native-server"],
      nativeSessionId: values["native-session"],
      ...(process.env.OPENCODE_SERVER_PASSWORD
        ? { nativePassword: process.env.OPENCODE_SERVER_PASSWORD }
        : {}),
      ...(process.env.OPENCODE_SERVER_USERNAME
        ? { nativeUsername: process.env.OPENCODE_SERVER_USERNAME }
        : {}),
      title:
        values.title ??
        (values["resume-import"]
          ? "Imported opencode session"
          : "Live opencode session"),
      visibility,
      secrets,
      signal: controller.signal,
      onReady: (recording) => {
        process.stdout.write(
          JSON.stringify({
            event: "publishing",
            ...recording,
            viewerUrl: viewerUrl(
              values.server ?? "http://127.0.0.1:7331",
              recording.streamId,
            ),
          }) + "\n",
        );
      },
      onStatus: (status) => {
        process.stdout.write(
          JSON.stringify({ event: "publisher-status", status }) + "\n",
        );
      },
      onNativeStatus: (status) => {
        process.stdout.write(
          JSON.stringify({ event: "native-status", status }) + "\n",
        );
      },
    });
    return;
  }
  if (values["native-server"])
    throw new Error("Native server applies only to OpenCode publishing");
  const agent = values.agent;
  let sourcePath = values.source;
  let selectedNative = false;
  const codexFamily = agent === "codex" && values["include-children"];
  const openCodeImportFamily =
    command === "import" && agent === "opencode" && values["include-children"];
  if (openCodeImportFamily && (!sourcePath || !values["source-root"]))
    throw new Error(
      "OpenCode family import requires --source <root-export> and --source-root <exports-directory>",
    );
  if (
    values["source-root"] &&
    sourcePath &&
    !codexFamily &&
    !openCodeImportFamily
  )
    throw new Error("Specify --source or --source-root, not both");
  if (
    !sourcePath &&
    values["native-session"] &&
    (agent === "codex" || agent === "claude" || agent === "kimi")
  ) {
    const defaults = {
      codex: join(
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        "sessions",
      ),
      claude: join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      ),
      kimi: join(homedir(), ".kimi-code", "sessions"),
    };
    const candidate = await selectNativeSession({
      agent,
      root: values["source-root"] ?? defaults[agent],
      nativeSessionId: values["native-session"],
      ...(values["native-agent"]
        ? { nativeAgent: values["native-agent"] }
        : {}),
      signal: controller.signal,
    });
    sourcePath = candidate.source;
    if (values.launch && agent === "kimi" && candidate.nativeAgent !== "main")
      throw new Error("Managed Kimi resume requires the main agent log");
    selectedNative = true;
    if (agent === "kimi" && candidate.nativeAgent)
      values["native-agent"] = candidate.nativeAgent;
  } else if (values["source-root"] && !codexFamily && !openCodeImportFamily)
    throw new Error("--source-root requires a file agent and --native-session");
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
    !selectedNative &&
    (Boolean(values["native-session"]) !== Boolean(values["native-agent"]) ||
      (agent !== "kimi" &&
        (values["native-session"] || values["native-agent"])))
  )
    throw new Error(
      "Specify both native identity options only for Kimi exports",
    );
  const secret = await loadCredential();
  secrets.push(secret);
  const options: Parameters<typeof importCodexRecording>[0] = {
    ...(remoteArtifacts ? { remoteArtifacts } : {}),
    ...(values["artifact-bundles"] ? { artifactBundles: true } : {}),
    sourcePath: resolve(sourcePath),
    publisherRoot: join(stateDir, "publisher"),
    serverOrigin: values.server ?? "http://127.0.0.1:7331",
    ownerCredential: secret,
    title:
      values.title ??
      `${command === "publish" && !values["resume-import"] ? "Live" : "Imported"} ${agent} session`,
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
  if (command === "publish") {
    if (agent !== "codex" && agent !== "claude" && agent !== "kimi")
      throw new Error(
        "Live file publishing currently supports Codex, Claude, and Kimi only",
      );
    if (agent !== "codex" && values["record-format"])
      throw new Error("Record format applies only to Codex");
    const recordFormat = values["record-format"] ?? "structured";
    if (recordFormat !== "structured" && recordFormat !== "legacy")
      throw new Error("Record format must be structured or legacy");
    const output = values.launch ? process.stderr : process.stdout;
    const publish = (
      hooks: Partial<Parameters<typeof publishCodexRecording>[0]> = {},
    ) =>
      (agent === "claude"
        ? publishClaudeRecording
        : agent === "kimi"
          ? publishKimiRecording
          : publishCodexRecording)({
        ...options,
        recordFormat,
        resumeImport: values["resume-import"] ?? false,
        expandFamily: values["expand-family"] ?? false,
        ...(codexFamily
          ? {
              familyRoot: resolve(
                values["source-root"] ??
                  join(
                    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
                    "sessions",
                  ),
              ),
            }
          : {}),
        ...(agent === "kimi" || agent === "claude"
          ? { includeChildren: values["include-children"] ?? false }
          : {}),
        ...(values["native-session"] && values["native-agent"]
          ? {
              nativeIdentity: {
                nativeSessionId: values["native-session"],
                agentId: values["native-agent"],
              },
            }
          : {}),
        onReady: (recording) => {
          output.write(
            JSON.stringify({
              event: "publishing",
              ...recording,
              viewerUrl: viewerUrl(
                values.server ?? "http://127.0.0.1:7331",
                recording.streamId,
              ),
            }) + "\n",
          );
        },
        onStatus: (status) => {
          output.write(
            JSON.stringify({ event: "publisher-status", status }) + "\n",
          );
        },
        onCaughtUp: async () => {
          output.write(JSON.stringify({ event: "source-caught-up" }) + "\n");
        },
        ...hooks,
      });
    if (values.launch) {
      const code = await managedFileResume({
        agent,
        cooperativeDrain: true,
        nativeSessionId: values["native-session"]!,
        sourcePath: options.sourcePath,
        cwd: resolve(values.cwd ?? process.cwd()),
        signal: controller.signal,
        publish,
        onStatus: (status) => {
          process.stderr.write(
            JSON.stringify({ event: "managed-launch", status }) + "\n",
          );
        },
      });
      if (code) throw new Error(`Native agent exited with status ${code}`);
    } else await publish();
    return;
  }
  const result =
    agent === "codex"
      ? await importCodexRecording({
          ...options,
          ...(codexFamily
            ? {
                familyRoot: resolve(
                  values["source-root"] ??
                    join(
                      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
                      "sessions",
                    ),
                ),
              }
            : {}),
        })
      : agent === "claude"
        ? await importClaudeRecording({
            ...options,
            includeChildren: values["include-children"] ?? false,
          })
        : agent === "opencode"
          ? await importOpenCodeRecording({
              ...options,
              ...(openCodeImportFamily
                ? { familyRoot: resolve(values["source-root"]!) }
                : {}),
            })
          : await importKimiRecording({
              ...options,
              includeChildren: values["include-children"] ?? false,
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
  if (outputClosed) process.exitCode = 0;
  else if (interrupted && !(error instanceof ShutdownTimeoutError))
    process.exitCode = interrupted;
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
