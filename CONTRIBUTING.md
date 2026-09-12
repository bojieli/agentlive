# Contributing to AgentLive

Thank you for helping. AgentLive records other people's coding sessions, so correctness, durability and privacy come before features.

## Set up

Use Node.js 26.8.1 (see `.node-version`) and pnpm 12.3.4:

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
npx --yes pnpm@12.3.4 check
```

`check` runs Prettier, the TypeScript project build, the browser bundle build and the offline Vitest suite. It makes no model or provider calls. CI runs `check` and `package:verify` on Linux and macOS.

Useful commands:

| Command                                        | Purpose                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npx --yes pnpm@12.3.4 build`                  | Build all packages and the browser bundle                                                     |
| `npx vitest run tests/recovery/<file>.test.ts` | Run one test file (CLI tests use `packages/cli/dist`, so build first)                         |
| `npx vitest run --maxWorkers=1`                | Full suite with one worker; the disk-heavy recovery tests are most reliable this way          |
| `npx --yes pnpm@12.3.4 package:verify`         | Build the standalone tarball, reproduce it byte-for-byte offline and test an isolated install |
| `npx --yes pnpm@12.3.4 package:lock`           | Refresh `packaging/runtime-lock.json` after intentionally changing runtime dependencies       |
| `node scripts/probe-browser.mjs`               | Rendered Chrome checks (needs Google Chrome)                                                  |

## Ground rules

- **No private data in the repository.** Never commit native transcripts, exported sessions, credentials, probe traces or screenshots of real sessions. Tests use synthetic fixtures; `probe-results/` is ignored. Aggregate corpus reports may contain counts only.
- **Opt-in probes cost money.** Scripts that start installed agents (`scripts/probe-*`) may incur provider charges and are never part of CI.
- **Durability invariants are the contract.** Read section 1 of the [implementation plan](IMPLEMENTATION_PLAN.md) before changing the publisher, server or storage. Acknowledge only after durable writes, never advance a cursor across a gap, keep event identity and attachment versions immutable, and prefer explicit capture gaps over guessed content.
- **Converter changes are versioned.** Changing what a converter emits for existing input requires a new converter identity so pinned import/publish bindings are not silently rewritten. See [converter migrations](docs/converter-migrations.md).
- **Bound everything.** New inputs need size, count and depth limits; new asynchronous work needs cancellation and bounded queues.
- **Dependencies are pinned.** Add the latest stable version with an exact pin, commit `pnpm-lock.yaml`, and regenerate the runtime lock for runtime dependencies. Run Prettier after pnpm rewrites the lockfile.
- **Tests with fixes.** Add a failing regression test for each bug and a focused test for each feature. Recovery behavior (restart, crash, partial writes, cancellation) belongs in `tests/recovery`.
- **Documentation must match behavior.** Update the [relevant guide](docs/README.md) or feature document with user-visible changes. Record verified evidence and remaining limitations honestly in `IMPLEMENTATION_STATUS.md`; never describe an open release gate as passed.

## Layout

See the package table in the [README](README.md#how-it-works). Design records live in `docs/decisions`, protocol and storage notes in `docs/protocol`, and rendered/terminal verification evidence in `docs/browser` and `docs/terminal`.

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

A read-only native transport/restart probe is available:

```sh
node scripts/probe-codex-publish.mjs /path/to/archived-session.jsonl
```

Run an explicit integration test against the installed Claude CLI (creates a new synthetic session and resumes it through the native CLI):

```sh
node scripts/probe-claude-publish.mjs
```

The installed Kimi CLI integration test creates a synthetic session, discovers it through `kimi session list`, resumes it natively while publishing, and checks publisher restart:

```sh
node scripts/probe-kimi-publish.mjs
```

```sh
node scripts/probe-opencode-publish.mjs
```

## Submitting changes

Open a pull request with a description of the behavior change, how it was verified (commands and results) and any remaining limitations. Keep unrelated refactors out of feature changes. Security issues follow [SECURITY.md](SECURITY.md) instead of public issues.
