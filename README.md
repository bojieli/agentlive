# AgentLive

Broadcast and replay coding-agent sessions from one stable session URL, with structured messages, tools, file changes, and versioned attachments.

**Implementation is in progress.** This repository currently contains the implementation plan, live-agent transport probes, and tested recorder/publisher/playback foundations plus a programmatic HTTP/WebSocket server, shared synchronization engines, and immutable attachment storage. A workspace CLI can start the server and import recordings from all four agents. The distributable installer and viewers are unfinished. See [implementation status](IMPLEMENTATION_STATUS.md) for verified work and remaining release gates.

## Development

Use **Node.js 26.8.1** and **pnpm 12.3.4**. Direct dependencies are pinned to the latest stable versions resolved when introduced; the lockfile makes installs reproducible.

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
npx --yes pnpm@12.3.4 check
```

`check` verifies formatting, builds the TypeScript packages, and runs offline tests. It makes no model calls. CI runs the same command on macOS and Linux with Node 26.

## Local server and history import

After installing and building the workspace:

```sh
npx --yes pnpm@12.3.4 build
npx --yes pnpm@12.3.4 agentlive serve
```

The server listens on `127.0.0.1:7331` and persists state under `~/.agentlive`. First startup creates an owner-only credential file at `~/.agentlive/owner.json`; subsequent starts reuse it. The ready message reports the server URL. Stop with Ctrl-C or SIGTERM to close storage cleanly.

In another terminal, import a retained session:

```sh
npx --yes pnpm@12.3.4 agentlive import --agent codex --source /path/to/session.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent claude --source /path/to/session.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent kimi --source /path/to/session_ID/agents/main/wire.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent opencode --source /path/to/opencode-export.json
```

Imports are private by default. Use `--visibility unlisted` or `--visibility public` to make a completed import readable without credentials. Import output includes the recording ID and conversion report; unsupported source objects remain visible in the report. Interactive viewers are not yet included; use terminal replay below.

Use `--state-dir` on both commands for isolated state, `--server` on imports for another server, and `--owner-file` for its credential JSON. An existing owner secret may instead be supplied through `AGENTLIVE_OWNER_SECRET`. Local artifact access defaults to the source directory; add explicit `--artifact-root` paths where needed. Moved Kimi exports require both `--native-session` and `--native-agent`. See `agentlive --help` for all options.

Inspect an imported recording in the terminal:

```sh
npx --yes pnpm@12.3.4 agentlive replay --stream <recording-id>
# For a public or unlisted recording on another server:
npx --yes pnpm@12.3.4 agentlive replay --stream <recording-id> --server https://example.test --anonymous
```

Replay downloads a fixed history boundary and prints timestamped messages, tools, file changes, attachment links, and capture gaps. Terminal control characters are escaped. This reference command prints immediately and caps normalized events at 64 MiB; playback-speed controls, paged state, and live watch remain unfinished. Private replay uses the same owner credential options as import.

These commands run from the source checkout. Clean standalone installation, automatic native-session discovery, live publishing commands, and interactive terminal/browser viewers remain release requirements.

## Live integration probes

These commands use installed agents and their existing credentials in newly created synthetic workspaces. They may incur provider usage charges. Raw traces are saved locally under ignored `probe-results/`; never commit traces without reviewing and sanitizing them.

```sh
# Claude partial-message stream and Codex app-server stdio
node scripts/probe-agents.mjs claude codex

# Kimi's local server transcript subscription
node scripts/probe-servers.mjs kimi

# OpenCode's local SSE server, with an explicitly selected configured provider
AGENTLIVE_PROBE_MODEL=anthropic/claude-sonnet-5 \
  node scripts/probe-servers.mjs opencode
```

No upstream binaries are patched. The probes start only their own local servers and stop those processes afterward. The live probes create synthetic sessions; separate native-history scripts test explicitly selected existing histories read-only. Provider selection stays on the publisher machine; AgentLive's eventual broadcast server will not require model credentials.

## Architecture

- `packages/protocol`: versioned event validation, identifiers, errors, canonical JSON.
- `packages/storage`: checksummed append-only logs, frozen-prefix reads, atomic JSON replacement, kernel-owned file locks.
- `packages/publisher`: persistent native-session bindings, local capture journal, acknowledgments, recovery state, streaming known-secret redaction.
- `packages/server`: serialized session core, idempotent creation, publisher fencing, and lifecycle/history boundaries (network service in progress).
- `packages/playback`: deterministic reference reducer and independent playback clock.
- `tests/recovery`: restart, corruption, interrupted-write, process-death, and ownership tests.

Recordings use JSONL and immutable attachment files. Live delivery will use in-memory buffers with durable history fallback. A database is not required for the initial multi-session deployment.

The complete product contract and milestones are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

The real Codex capture-to-replay test also exercises a read-only tool and native app-server restart/resume:

```sh
npx --yes pnpm@12.3.4 build
node scripts/probe-codex-pipeline.mjs
```


Native history import is available through the four agent-specific programmatic import APIs and the workspace CLI. Its isolated local validation script imports an explicitly selected source file into a private test server and checks replay and retry identity:

```sh
npx --yes pnpm@12.3.4 build
node scripts/probe-history-import.mjs /path/to/codex-session.jsonl
```

The distributable npm package is not yet built. See [native-history corpus coverage](docs/adapters/NATIVE_HISTORY_CORPUS.md) for tested behavior and unresolved object/artifact types.
