# Implementation status

Last updated: 2026-09-11. **Production gate: not passed.** Every feature listed here works in the scenarios its tests cover; the M0–M7 exit gates of the [implementation plan](IMPLEMENTATION_PLAN.md#15-implementation-phases-and-exit-gates) still require acceptance evidence that local tests cannot provide. The ordered task list is [REMAINING_WORK.md](REMAINING_WORK.md). The detailed checkpoint history that used to live in this file is preserved verbatim in [docs/history/implementation-status-log.md](docs/history/implementation-status-log.md).

## Current verification

| Check | Result (2026-09-11, macOS arm64, Node 26.8.1) |
| --- | --- |
| Full offline suite (`vitest run --maxWorkers=1`) | 693 tests in 135 files passed (258 s). The closed-pipe replay fix and sample-archive test added afterwards pass in their focused file (3 tests) |
| Formatting, TypeScript project build, browser bundle | Pass |
| Standalone package (`package:verify`: offline reproducible rebuild, isolated install, serve/import/replay/archive/backup round trips) | Pass: `agentlive-0.1.0.tgz`, byte-identical offline rebuild, isolated install with scripts disabled, 27 passing installed-package checks |
| CI (Linux + macOS) | Last confirmed at `2bcb9ca`; this checkpoint is confirmed only once CI passes on the pushed commit |
| Rendered Chrome probes | 21 checks passed at the last browser checkpoint (2026-09-10); not rerun for this checkpoint ([evidence](docs/browser/README.md)) |
| Docker image probe | 11 container checks passed on 2026-09-10 ([evidence](deployment/container-admin-probe-2026-09-10.json)); predates this checkpoint |

Local tests use synthetic fixtures and make no model calls. They are correctness evidence, not native-version, device, deployment or performance acceptance.

## What works today

- **Agents.** Claude Code, Codex, Kimi Code and OpenCode: historical import, live publishing, managed fresh/resumed launch, discovery by native identity, parent/subagent family capture and import, import-to-live continuation, scope expansion, frozen-import source relocation and replacement migration (same or another server). See [compatibility](docs/compatibility.md) for fidelity per agent.
- **Publisher.** Durable filtered journal and immutable artifact spool before delivery, restart/reconnect deduplication, known-secret redaction, authenticated remote artifacts and portable HTML bundles, credential rotation/revocation, explicit recovery after server restore. Publication control: `status`, `pause`, `resume`, `finish`, `reopen`, `retire`, `doctor`; every publish reports its stable viewer URL.
- **Server.** One JSONL log per recording with single-writer fencing, HTTP history, WebSocket live delivery, resident-session cache, paged snapshots with leases, readiness checks, graceful drain. Private by default; scoped revocable viewing grants; in-flight private HTTP transfers are aborted when their authorizing credential, grant, session or device is revoked or the recording becomes private or is removed. Offline and online backup, restore with fresh revisions, removal with cleanup, abuse reports and operator review. Optional hosted mode: OIDC login, device login, account ownership/isolation, public discovery, operator account listing and disable/enable.
- **Viewers.** Browser and terminal share the synchronization and paged playback engine: independent receipt and presentation, pause/step/seek/speed/idle caps, return to live, search, bounded text pages, persisted inspection choices, verified attachment previews (text, PNG/JPEG/WebP, isolated HTML/bundles, opt-in isolated scripts). Completeness notices for recordings imported from unfinished native sessions.
- **Portability and packaging.** `.agentlive` export, offline replay and import; standalone npm tarball `agentlive` with a reviewed runtime lock; Docker/Compose with a non-root read-only image; MIT license.

## Added at this checkpoint (2026-09-11)

- Publication-control CLI (`status`, `pause`, `resume`, `finish`, `reopen`, `retire`, `doctor`), viewer URLs in publish output, `watch`/`replay` accepting a viewer URL, and `/s/<id>` short links. Tests: `tests/recovery/publication-cli.test.ts`.
- Operator account administration (`accounts`, `account-status`, owner-only admin routes); disabling immediately ends the account's sessions, transfers and sockets. Tests: `tests/recovery/account-admin.test.ts`.
- Online server backup (`backup --server`, owner-only `POST /api/v1/admin/backup`): a write barrier pauses durable writes, not reads, and the output is in the offline restore format. Tests: `tests/recovery/server-online-backup.test.ts`. See [server backups](docs/server-backups.md).
- In-flight HTTP transfer revocation for account sessions, devices, account disable, publisher credentials, viewing grants, visibility changes and removal; open viewing WebSockets are rechecked at the same points and close immediately. Tests: `tests/recovery/transfer-revocation.test.ts`. See [hosted identity](docs/hosted-identity.md).
- Persisted `capture.completeness` notices emitted by importers at a frozen boundary, rendered by both viewers and carried in archive provenance, with legacy import bindings left unchanged. Tests: `tests/recovery/completeness-notice.test.ts`, `import-completeness.test.ts`. See [converter migrations](docs/converter-migrations.md).
- A synthetic [sample recording](docs/sample/README.md) generated through the real CLI and replayed by the offline suite; `replay | head` now exits quietly instead of crashing on a closed pipe.
- Publication documents: rewritten [README](README.md), [usage guide](docs/usage.md), [compatibility matrix](docs/compatibility.md), [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [CHANGELOG](CHANGELOG.md), MIT [LICENSE](LICENSE); the release package is renamed `agentlive`.

## Production exit gates

No gate is marked passed merely because part of its implementation exists.

| Gate | Implemented and locally verified | Still required before passing |
| --- | --- | --- |
| M0: Feasibility and identity | Transport probes and import/live/launch implementations for all four agents; durable identity bindings; [compatibility matrix](docs/compatibility.md) | Capability contract verified across supported native versions; no adapter yet publishes token-level deltas |
| M1: Protocol and recorder | Schemas, deterministic reducers, filtering, persistent bindings, event/artifact spools, recovery tests | Durable capture before the first remote binding; segmented spool pruning; publisher epoch handoff; remaining lifecycle fault matrix |
| M2: Server vertical slice | JSONL/HTTP/WebSocket server, private access, browser/terminal viewing, restart and export/replay equivalence | Full cross-component recovery matrix; operational bounds and production content collection |
| M3: Complete adapters | Four adapters, family capture, remote/bundled artifacts, completeness notices, corpus evidence | Full common failure/fidelity matrix (interrupted tools, approvals, auth failures, source rotation) on real native versions; general converter/filter migration of live bindings |
| M4: Playback and viewers | Paged state in both browser modes and terminal; snapshots, leases, pins, memory collection, inspection persistence | 500,000-event / eight-hour acceptance (currently failing); device, screen-reader, suspension and eviction matrix |
| M5: Standalone release candidate | Tarball, archives, Docker/Compose, offline and online backup/restore, publisher recovery | Recording-format upgrade/rollback; retention and global quotas; all-adapter verification through the installed package; Windows/WSL statement; actual-host HTTPS deployment |
| M6: Centralized pilot | OIDC/device login, account isolation, grants, in-flight revocation, removal, reports | Per-account quotas, operational monitoring, real identity provider, deployed concurrent pilot with restore verification |
| M7: Public release | License, README, usage, compatibility, contribution and security documents; reproducible package; [sample recording](docs/sample/README.md) replayed by the suite | Measured published limits, signed/provenance publishing, external testers in both deployment modes, npm/repository publication |

## Known limits

- **Capacity.** The 500,000-event long-session target has not been met: the retained [performance reports](docs/performance/README.md) record quota and collection-latency failures. A 100,000-event backend workload completes, but with a multi-second seek that includes collection.
- **Fidelity.** Text appears as native records or snapshots are written, not token by token. Unsupported native objects are explicit gaps, not rendered content.
- **Platforms.** Linux and macOS only; Windows/WSL are unverified. Browser evidence is headless Chrome at desktop and mobile viewport sizes, not physical devices or other engines.
- **Operations.** Recording-format migrations and automated rollback are not implemented. Online backup writes to the server host's filesystem.
