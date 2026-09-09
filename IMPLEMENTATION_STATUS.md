# Implementation status

Last updated: 2026-09-09. This document records evidence and unfinished work; it does not replace or reduce the scope of the implementation plan.

## Current verified work

- Node 26.8.1 baseline; exact dependency versions and pnpm lockfile. No Node 24 support target.
- Strict TypeScript workspace with protocol, storage, publisher, playback, client, and server packages.
- Schema-validated event content and producer identity; deterministic JSON encoding rejects non-JSON/cyclic/lossy values.
- Serialized JSONL appends with durable flush before resolving, chained checksums, sparse seek positions, frozen-prefix reads, and explicit corruption errors.
- Recovery removes an incomplete final line while preserving complete records; complete checksum corruption is not silently truncated.
- Atomic JSON checkpoints and kernel advisory locks, including automatic release after actual process death and continued ownership during process suspension.
- Persistent publisher bindings reuse stream identity, credential, producer sequence, native-source checkpoint, sharing intent, and pending events after reopening.
- Source retry deduplication and conflict detection; bounded Bloom filter avoids full journal scans for normally new source identities.
- Known-secret streaming redaction across every tested split, including overlapping secrets and Unicode text.
- Reference reducer preserves previous state, reconciles completed messages without duplicate text, and retains immutable artifact versions. Playback position/speed are separate from receipt of live events.
- Server core supports idempotent session creation, hashed write credentials, serialized append/deduplication, reconnect fencing, frozen history/live boundaries, and explicit idempotent finish/reopen.
- Immutable attachment byte storage checks hashes and size, reserves quota, cleans interrupted uploads, and commits availability only after bytes are durable. Referenced versions survive garbage collection and reopening.
- HTTP and WebSocket server module provides owner-authorized creation, publisher resume/ACKs, paged JSONL history, private viewing authorization, scoped one-use browser tickets, and attachment upload/download. Subscriber queues are bounded; the packaged UI and command-line entrypoints are not yet built.
- Shared browser-compatible subscriber engine joins with a scoped ticket, catches up paged history, buffers live events within a byte limit, falls back to history after buffer eviction, and advances receipt only after the consumer commits state. Reconnect, private access, stale cursors, and truncated history are tested using Node’s native WebSocket; real-browser validation remains.
- Publisher network pump creates/binds idempotently, durably increments connection attempts, reconciles server ACKs, sends bounded batches, and automatically reconnects. Integration tests cover server downtime, offline capture after binding, publisher restart with a lost ACK, and persistent sharing pause.
- 58 offline tests pass locally, including actual child-process SIGKILL and SIGSTOP scenarios. Command: `npx --yes pnpm@12.3.4 check`.
- Four real local agent transports exercised against synthetic prompts. Details and corrected failed attempts are in [live probe evidence](docs/adapters/LIVE_PROBES.md).

## Milestone gates

| Gate | Status | Remaining evidence/work |
| --- | --- | --- |
| M0 feasibility and identity | In progress | All four have a successful streaming transport probe; native-TUI attachment, source-session resume, tools/edits/approvals/cancellation/subagents, and attachment coverage still need the full scenario matrix. Scoped npm name returned no existing package but has not been reserved or published. |
| M1 protocol and recorder | In progress | Add segmented spool pruning with safe checkpoint dependencies, source-clock restart mappings, attachment spool/version pipeline, adapter normalization, compatible snapshot serialization, full schemas and fixtures. Current reference reducer is for bounded fixtures; paged production state is not built. |
| M2 server and first vertical slice | In progress | Core create/session-writer/lease/dedup/lifecycle and history-boundary tests are implemented. Remaining: bounded session eviction, epoch handoff, complete access management, client storage integration, CLI/viewers, and real Codex publish-to-replay. |
| M3 complete adapters | Not implemented | Production transports and normalization for Claude, Codex, Kimi, OpenCode; resume and fidelity behavior; uploads/artifacts; operator approval/cancel integration. Probe scripts are evidence, not production adapters. |
| M4 playback and viewers | In progress | Shared subscriber engine is tested against the server. Remaining: browser/mobile/Ink clients, paged state/snapshots, timeline controls, previews, background/cache recovery, full viewer failure matrix. |
| M5 standalone release candidate | Not implemented | Bundled npm CLI, Docker, auth/visibility, import/export, retention, deletion, backup/restore, upgrade support, clean-install verification. |
| M6 centralized pilot | Not implemented | Hosted identity/device flow, account isolation/quotas, monitoring/removal workflows, same-server multi-session pilot deployment and restoration test. |
| M7 public release | Not implemented | Full compatibility/limits evidence, contribution/license/release materials, external install/publish/watch/replay validation, publication. Repository remains private. |

## Immediate implementation sequence

1. Finish recorder storage contracts: safe segmented pruning, attachment bytes, stable clock segments, crash-safe lifecycle checkpoints.
2. Extend the implemented server and network surfaces with bounded session eviction, complete credential lifecycle, and publisher epoch handoff.
3. Connect the implemented publisher/subscriber synchronization engines to a production Codex adapter and viewer, then complete the remaining native adapters using verified live interfaces.
4. Continue all remaining viewer, packaging, hosted-service, deployment, and release gates; do not claim completion from the foundation tests alone.

## Known limits of current code

The publisher journal retains its captured history up to a configured byte limit; it does not prune acknowledged segments yet. Capturing before the first remote binding is established is not implemented. Server attachment upload/download and a programmatic HTTP/WebSocket listener are implemented and integration-tested; publisher artifact capture/rewriting, browser/terminal viewers, and a packaged CLI are not. Private access currently uses owner/publisher credentials or scoped short-lived viewing tickets; revocation, read-only credential management, and hosted authentication remain. Its session cache is not yet bounded, publisher epoch handoff is not implemented, and readiness does not yet test storage writability. File-lock prebuild installation and all 31 tests, including the server core, passed GitHub CI on both macOS and Linux with Node 26 at code commit a7ffe90 (run 34314717999). The attachment/HTTP checkpoint also passed all 45 tests on both CI platforms at b9a2948 (run 34315873255). Source/session recovery behavior of each actual agent is not yet established by the short streaming probes.

The shared subscriber engine requires a consumer that commits its state and receipt cursor together; persistent browser/terminal caches are not implemented. The publisher transport currently requires remote creation/binding before capture, does not yet upload attachment dependencies, and does not resolve an expired initial creation request automatically. These are remaining implementation requirements, not claims of completed offline-first agent capture.
