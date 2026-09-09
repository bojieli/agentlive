# AgentLive

Broadcast and replay coding-agent sessions from one stable session URL, with structured messages, tools, file changes, and versioned attachments.

**Implementation is in progress.** This repository currently contains the implementation plan, live-agent transport probes, and tested recorder/publisher/playback foundations plus a programmatic HTTP/WebSocket server, shared synchronization engines, and immutable attachment storage. It is not yet an installable broadcast server or finished viewer. See [implementation status](IMPLEMENTATION_STATUS.md) for verified work and remaining release gates.

## Development

Use **Node.js 26.8.1** and **pnpm 12.3.4**. Direct dependencies are pinned to the latest stable versions resolved when introduced; the lockfile makes installs reproducible.

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
npx --yes pnpm@12.3.4 check
```

`check` verifies formatting, builds the TypeScript packages, and runs offline tests. It makes no model calls. CI runs the same command on macOS and Linux with Node 26.

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

No upstream binaries are patched. The probes start only their own local servers and stop those processes afterward. Existing user sessions are not used as fixtures. Provider selection stays on the publisher machine; AgentLive's eventual broadcast server will not require model credentials.

## Architecture

- `packages/protocol`: versioned event validation, identifiers, errors, canonical JSON.
- `packages/storage`: checksummed append-only logs, frozen-prefix reads, atomic JSON replacement, kernel-owned file locks.
- `packages/publisher`: persistent native-session bindings, local capture journal, acknowledgments, recovery state, streaming known-secret redaction.
- `packages/server`: serialized session core, idempotent creation, publisher fencing, and lifecycle/history boundaries (network service in progress).
- `packages/playback`: deterministic reference reducer and independent playback clock.
- `tests/recovery`: restart, corruption, interrupted-write, process-death, and ownership tests.

Recordings use JSONL and immutable attachment files. Live delivery will use in-memory buffers with durable history fallback. A database is not required for the initial multi-session deployment.

The complete product contract and milestones are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
