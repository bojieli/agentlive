# AgentLive documentation

Start with the [README](../README.md) for what AgentLive is and a five-minute start.

## I want to…

|                            |                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Install it**             | [Installing](install.md) — requirements, building from source, verifying the package                                                                                         |
| **Record a session**       | [Recording](recording.md) — import history, attach to a running session, launch an agent under AgentLive, capture subagents and artifacts, pause/finish/reopen               |
| **Watch one**              | [Watching and replaying](viewing.md) — the browser viewer, the terminal viewer, seeking, speed, idle-gap compression, offline replay                                         |
| **Share it**               | [Sharing and moving](sharing.md) — visibility, portable `.agentlive` files, moving a recording between servers                                                               |
| **Run a server**           | [Operating](operating.md) — serve options, storage limits, metrics · [Deployment](../deployment/README.md) — Docker, HTTPS, Cloudflare tunnel · [Backups](server-backups.md) |
| **Fix something**          | [Troubleshooting](troubleshooting.md) — `doctor`, common errors, what to do about a leak                                                                                     |
| **Know what I'm getting**  | [Compatibility](compatibility.md) — per-agent capture fidelity · [Limits](limits.md) — enforced limits and measured performance                                              |
| **Try it and report back** | [Testing guide](testing.md) — the journey to walk, and what is worth telling us                                                                                              |

## Features in depth

- [Viewing credentials](viewing-credentials.md) — scoped, revocable per-recording access
- [Publisher credentials](publisher-credentials.md) — rotation and revocation
- [Hosted identity](hosted-identity.md) — OIDC sign-in, device login, accounts, quotas, operator administration
- [Recording archives](recording-archives.md) — the portable `.agentlive` format
- [Remote artifacts](remote-artifacts.md) and [artifact bundles](artifact-bundles.md) — capturing files the session refers to
- [Recording removal](recording-removal.md) and [abuse reports](abuse-reports.md)
- [Converter migrations](converter-migrations.md) — changing conversion or filtering policy on an existing recording
- [OpenCode revert projection](opencode-revert.md)

## Internals

- [Protocol and storage notes](protocol/) — events, paged state, snapshots, content addressing, client synchronization
- [Design decisions](decisions/) — why JSONL and single-process ownership
- [The implementation plan](../IMPLEMENTATION_PLAN.md) — the full product contract and its exit gates

## Evidence

Claims in these documents are backed by runs kept in the repository:

- [Adapter probes](adapters/LIVE_PROBES.md) and the [native-history corpus](adapters/NATIVE_HISTORY_CORPUS.md) — conversion over every local session, aggregate counts only
- [Browser](browser/README.md) — rendered Chrome runs, keyboard and accessibility checks
- [Terminal](terminal/README.md) — real pseudo-terminal runs
- [Performance](performance/README.md) — long-session and concurrent-load measurements
- [History](history/) — the verbatim status and remaining-work logs through 2026-09-11

Current state and open gates: [implementation status](../IMPLEMENTATION_STATUS.md) · [remaining work](../REMAINING_WORK.md)
