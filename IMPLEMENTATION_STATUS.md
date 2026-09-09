# Implementation status

Last updated: 2026-09-09. This document records evidence and unfinished work; it does not replace or reduce the scope of the implementation plan.

## Current verified work

- Node 26.8.1 baseline; exact dependency versions and pnpm lockfile. No Node 24 support target.
- Strict TypeScript workspace with protocol, storage, publisher, and playback packages.
- Schema-validated event content and producer identity; deterministic JSON encoding rejects non-JSON/cyclic/lossy values.
- Serialized JSONL appends with durable flush before resolving, chained checksums, sparse seek positions, frozen-prefix reads, and explicit corruption errors.
- Recovery removes an incomplete final line while preserving complete records; complete checksum corruption is not silently truncated.
- Atomic JSON checkpoints and kernel advisory locks, including automatic release after actual process death and continued ownership during process suspension.
- Persistent publisher bindings reuse stream identity, credential, producer sequence, native-source checkpoint, sharing intent, and pending events after reopening.
- Source retry deduplication and conflict detection; bounded Bloom filter avoids full journal scans for normally new source identities.
- Known-secret streaming redaction across every tested split, including overlapping secrets and Unicode text.
- Reference reducer preserves previous state, reconciles completed messages without duplicate text, and retains immutable artifact versions. Playback position/speed are separate from receipt of live events.
- Server core supports idempotent session creation, hashed write credentials, serialized append/deduplication, reconnect fencing, frozen history/live boundaries, and explicit idempotent finish/reopen. HTTP/WebSocket routes and attachment availability are not implemented yet.
- 31 offline tests pass locally, including actual child-process SIGKILL and SIGSTOP scenarios. Command: `npx --yes pnpm@12.3.4 check`.
- Four real local agent transports exercised against synthetic prompts. Details and corrected failed attempts are in [live probe evidence](docs/adapters/LIVE_PROBES.md).

## Milestone gates

| Gate | Status | Remaining evidence/work |
| --- | --- | --- |
| M0 feasibility and identity | In progress | All four have a successful streaming transport probe; native-TUI attachment, source-session resume, tools/edits/approvals/cancellation/subagents, and attachment coverage still need the full scenario matrix. Scoped npm name returned no existing package but has not been reserved or published. |
| M1 protocol and recorder | In progress | Add segmented spool pruning with safe checkpoint dependencies, source-clock restart mappings, attachment spool/version pipeline, adapter normalization, compatible snapshot serialization, full schemas and fixtures. Current reference reducer is for bounded fixtures; paged production state is not built. |
| M2 server and first vertical slice | In progress | Core create/session-writer/lease/dedup/lifecycle and history-boundary tests are implemented. Remaining: bounded session eviction, epoch handoff, attachment availability, HTTP routes, network auth, WebSocket synchronization, CLI/viewers, and real Codex publish-to-replay. |
| M3 complete adapters | Not implemented | Production transports and normalization for Claude, Codex, Kimi, OpenCode; resume and fidelity behavior; uploads/artifacts; operator approval/cancel integration. Probe scripts are evidence, not production adapters. |
| M4 playback and viewers | Not implemented | Shared subscriber synchronization, browser/mobile/Ink clients, paged state/snapshots, timeline controls, previews, background/cache recovery, full viewer failure matrix. |
| M5 standalone release candidate | Not implemented | Bundled npm CLI, Docker, auth/visibility, import/export, retention, deletion, backup/restore, upgrade support, clean-install verification. |
| M6 centralized pilot | Not implemented | Hosted identity/device flow, account isolation/quotas, monitoring/removal workflows, same-server multi-session pilot deployment and restoration test. |
| M7 public release | Not implemented | Full compatibility/limits evidence, contribution/license/release materials, external install/publish/watch/replay validation, publication. Repository remains private. |

## Immediate implementation sequence

1. Finish recorder storage contracts: safe segmented pruning, attachment bytes, stable clock segments, crash-safe lifecycle checkpoints.
2. Implement the serialized server session writer and idempotent creation/lease/append contracts with recovery tests before adding network routes.
3. Implement one shared publisher/subscriber transport protocol and complete the Codex vertical slice, then complete the remaining native adapters using verified live interfaces.
4. Continue all remaining viewer, packaging, hosted-service, deployment, and release gates; do not claim completion from the foundation tests alone.

## Known limits of current code

The publisher journal retains its captured history up to a configured byte limit; it does not prune acknowledged segments yet. Capturing before the first remote binding is established is not implemented. Attachment references are modeled but attachment storage/upload is not implemented. The server core has no HTTP listener or viewer yet; it does not expose these modules to external users. Its session cache is not yet bounded, publisher epoch handoff is not implemented, and attachment-availability events are rejected until byte storage is integrated. File-lock prebuild installation and all 31 tests, including the server core, passed GitHub CI on both macOS and Linux with Node 26 at code commit a7ffe90 (run 34314717999). Source/session recovery behavior of each actual agent is not yet established by the short streaming probes.
