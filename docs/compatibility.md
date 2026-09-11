# Agent compatibility and capture fidelity

AgentLive captures what each coding agent durably exposes on the publisher machine. It never requires model credentials on the server, and it never invents history the source did not record: unsupported source objects become explicit capture gaps, and missing artifacts become explicit unavailable versions.

**No adapter currently publishes token-level text deltas.** The live transport probes in [adapters/LIVE_PROBES.md](adapters/LIVE_PROBES.md) show that every agent has a delta-capable transport, but the shipped publishers follow each agent's retained history (Claude, Codex, Kimi) or observe snapshots from its native server (OpenCode). Text therefore appears as records or snapshots are written, not as individual tokens. Recorded timing reflects source timestamps where available.

## Matrix

| | Claude Code | Codex | Kimi Code | OpenCode |
| --- | --- | --- | --- | --- |
| Live capture source | Retained transcript JSONL (`$CLAUDE_CONFIG_DIR/projects`, default `~/.claude/projects`) | Rollout JSONL (`$CODEX_HOME/sessions`, default `~/.codex/sessions`), structured or `legacy` record format | Per-agent `wire.jsonl` under `~/.kimi-code/sessions/session_<id>/agents/<agent>/` | Native HTTP server (`opencode serve`) session snapshots |
| Text granularity | Complete appended records | Complete appended items | Complete appended wire records | Observed snapshots; unfinished secret-prefix text tails are withheld until complete |
| Tools and results | Calls, results and failures | Commands, file changes, MCP calls, subagent/collaboration items | Tool calls/results, background tasks, goals, approvals/questions (passive), plans | Tool states and results |
| Historical import | Transcript file | Rollout file | Wire log | `opencode export <id>` JSON |
| Attach to an existing session | Follow retained file | Follow retained file | Follow retained file | `--native-server <origin> --native-session <id>` |
| Managed launch (new / resume) | Yes / yes (`claude --session-id`, `--resume`) | Yes / yes (app-server thread create, `codex resume`) | Yes / yes (ACP `session/new`, `kimi --session`) | Yes / yes (owned loopback server + `opencode attach`) |
| Parent/subagent capture (`--include-children`) | `subagents/agent-<id>.jsonl` | Child rollouts sharing a logical session (structured records) | Sibling agent logs in one session | Descendant sessions via native `parentID` |
| Inline images/documents | Base64 image/document blocks | `local_image`, `ImageView` paths, image URLs and data URLs | `image_url` / `audio_url` / `video_url` parts | Data-URL files; `file:` references within `--artifact-root` |
| Authenticated remote artifacts | `--remote-artifact-policy` | `--remote-artifact-policy` | `--remote-artifact-policy` | `--remote-artifact-policy` |
| HTML artifact bundles | `--artifact-bundles` | `--artifact-bundles` | `--artifact-bundles` | `--artifact-bundles` |
| Resume identity | Session UUID | Thread ID (logical session + thread) | `session_` protocol ID and agent ID | Session ID |
| Native version exercised | 2.1.266 | 0.153.4 | 0.41.0 | 1.18.30 |

"Native version exercised" is the version used by the local transport and managed-launch probes on macOS arm64. It is evidence, not a support range: native history formats change, and each converter identity is pinned so that a changed converter requires explicit migration rather than silently rewriting a recording ([converter migrations](converter-migrations.md)).

## Known limitations by agent

- **Claude Code.** Bridge/bookkeeping ledgers without standalone session identity or timestamps are rejected rather than imported (35 of 1,588 files in the local corpus). File-history snapshots/deltas, queue operations and some attachment records remain explicit gaps. Reasoning/signatures are omitted by default.
- **Codex.** Extension items and a small number of skill blocks remain explicit gaps. Mixed-thread *legacy* child rollouts are rejected for family capture because they lack structured ownership. Live text deltas from the app-server are not captured by file following.
- **Kimi Code.** Runtime/telemetry, turn lifecycle and tool-store records remain explicit gaps. Shared session membership does not establish a parent relationship, so none is inferred between sibling agents.
- **OpenCode.** Capture preserves observed snapshots, not every native delta notification. Discovery covers the native server's workspace scope. Imports read per-session exports; a family import requires every exported descendant.

## Platforms

CI runs on Linux and macOS with Node 26.8.1. Windows and WSL have not been verified. Server platform support is separate from agent availability: the server needs no agent installed, and native agents run on the publisher machine.

## Evidence

- [Live transport probes](adapters/LIVE_PROBES.md) and [native history corpus](adapters/NATIVE_HISTORY_CORPUS.md): conversion, reducer and terminal-render passes over local histories (aggregate counts only; no transcript content is committed).
- Synthetic end-to-end tests in `tests/recovery` cover import, live publish, restart deduplication, family capture, artifacts and archives for all four agents without model calls.
- Opt-in probes (`scripts/probe-*.mjs`) exercise installed agents and may incur provider charges; see the [usage guide](usage.md#live-integration-probes).

Real interactive acceptance across supported native versions, provider failures and interrupted native work remain release gates tracked in [implementation status](../IMPLEMENTATION_STATUS.md).
