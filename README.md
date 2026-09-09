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

Follow a retained Codex JSONL history and publish subsequent appends:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent codex --source /path/to/session.jsonl
```

Start `serve` first using the same state directory. Publishing defaults to private visibility. Use `--record-format legacy` for older histories without structured item records. Stop with Ctrl-C and run the same command to resume the same recording; it stays open, and pending captured events remain on disk. The initial retained history is included. Source catch-up and remote delivery are separate states: `source-caught-up` reports local conversion, while publisher status reports network progress.

This command currently supports Codex, Claude Code, and Kimi Code. Initial recording creation needs connectivity; an existing binding can capture text while disconnected. Attachment upload can pause conversion until connectivity returns. Switching an ended import into a live recording still requires an explicit migration that is not yet implemented.

A read-only native transport/restart probe is available:

```sh
node scripts/probe-codex-publish.mjs /path/to/archived-session.jsonl
```

Watch a recording with automatic history catch-up and reconnect:

```sh
npx --yes pnpm@12.3.4 agentlive watch --stream <recording-id>
```

Use `--anonymous` for recordings that permit anonymous reads, or the existing owner credential options for private recordings. The local subscriber cache stores checksummed JSONL under `<state-dir>/subscriber`; it contains received recording content, but does not store the connection credential. Restarting displays the cached prefix and then reconnects from its durable receipt cursor. Cached history can render while the server is offline. Reconnection never silently switches to a different recording revision.

This is the terminal reference viewer: completed messages, tools, and supported state updates render as they arrive. Token-by-token presentation, interactive playback controls, and paged state remain unfinished. It currently enforces a 64 MiB event budget for in-memory playback and a separate 512 MiB durable cache limit. Cache reconstruction replays history from the beginning; storage pagination and snapshots remain in the plan.

Claude Code uses the same durable publication path:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent claude --source /path/to/session.jsonl
```

It backfills retained messages and tool state, then follows complete appended records. Partial trailing writes remain deferred until the next append. Restarting reconstructs tool state before processing new results. Native inline images/documents use the existing attachment spool; unsupported native objects retain explicit capture gaps. This single-file adapter does not yet merge parent/subagent files or expose token deltas absent from the native history.

Run an explicit integration test against the installed Claude CLI (creates a new synthetic session and resumes it through the native CLI):

```sh
node scripts/probe-claude-publish.mjs
```

Kimi Code can publish one retained agent wire log:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent kimi \
  --source /path/to/session_ID/agents/main/wire.jsonl
```

The adapter derives native identity from the session directory. For a moved wire file, provide both `--native-session <id>` and `--native-agent <name>`. Goals, tasks, recorded interactions, and plans share the same stateful conversion used by historical import. A binding currently follows one agent file; combining the main agent and subagent files remains unfinished.

The installed Kimi CLI integration test creates a synthetic session, discovers it through `kimi session list`, resumes it natively while publishing, and checks publisher restart:

```sh
node scripts/probe-kimi-publish.mjs
```
