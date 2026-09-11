# Remaining work toward the full AgentLive goal

Updated 2026-09-11. The current verified state and gate table are in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). The previous inventory and its checkpoint notes are preserved verbatim in [docs/history/remaining-work-log.md](docs/history/remaining-work-log.md). No individual item closes an M0–M7 gate by itself.

## Execution order

The user-directed order remains: finish missing product features, then performance/capacity and lifecycle hardening, then broad acceptance and publication. Benchmarks stay paused until feature work is complete.

1. **Converter/filter migration of existing live bindings.** Frozen-import replacement, source relocation, cross-server replacement and archive lineage are implemented. Still open: compatible checkpoint rebuilding, migrating an *existing live* binding to a new converter/filter policy in place, and archive-only server transfer.
2. **Native fidelity and artifacts.** Completeness notices now cover unfinished messages and tools; extend them to running tasks, pending interactions and pending attachments. Close remaining per-agent source gaps where evidence permits (see [compatibility](docs/compatibility.md)), broaden media/module/HTML fidelity, and define frozen-import finalization for withheld OpenCode text tails.
3. **Hosted authorization follow-ups.** Per-account quotas; real identity-provider acceptance; concurrent logout/disable race coverage beyond the tested revocation points.
4. **Operations.** Recording-format upgrade and tested rollback automation. Online backup is implemented and passes the container probe; exercise it on an actual host.
5. **Performance, capacity and lifecycle.** Meet the 500,000-event / eight-hour seek target; retention, global and account quotas; safe automatic server content collection; publisher spool pruning and durability before the first remote binding; independent artifact delivery; report archival; suspension/device/accessibility acceptance.
6. **Release acceptance and publication.** Current-release CI, package and container verification; deployed pilot; npm publication with provenance through the prepared [release workflow](RELEASING.md) (needs an `NPM_TOKEN` in the `npm` environment and a version tag); external testers completing publish → watch → rewind → catch up → replay in both deployment modes.

## 1. Scalable playback and complete viewers — M1/M4

- Measure and optimize paged playback against the long-session targets: the 500,000-event runs failed on content quota and collection latency, and the 100,000-event workload's middle seek takes seconds because it includes collection. See [performance](docs/performance/README.md).
- Offline historical suffixes: browser seeks beyond cached content still require server access.
- Extend search to historical versions where required; it currently covers the selected snapshot.
- Verify physical desktop/mobile devices, screen readers, real storage quota pressure and eviction, crashes during IndexedDB transactions, suspension/resume, and complete keyboard flows. Headless Chrome evidence is in [docs/browser](docs/browser/README.md).
- Richer diff and inspection layouts; remaining terminal replay-seek/resize behavior.
- Multi-tab root publication/recovery coordination beyond the implemented generation fencing.

## 2. Native-agent integration and fidelity — M0/M3

- Real interactive acceptance across supported native versions for launch, attach and family workflows, including installation/uninstallation of any hook integrations.
- Active-turn crash recovery, interrupted tools, approval/cancellation, subscription/authentication failures and source rotation/truncation across all four agents.
- Token-level delta capture where a supported transport exists; OpenCode currently reconciles observed snapshots.
- Missing-identity Claude ledgers and other source-object gaps where evidence permits; otherwise keep explicit capability limits.
- An evidence-backed compatibility matrix from the full common scenario suite.

## 3. Attachments and artifacts — M3/M4/M5

- Broader provider/media coverage per adapter; retain explicit unavailable historical versions.
- Bundle dependency fidelity beyond HTML/CSS, responsive images and captured JavaScript imports (computed imports, import maps, XML/SVG vocabularies, runtime resources).
- Broader media and module-syntax previews; cross-browser isolation and resource-exhaustion acceptance.
- Interrupted/versioned uploads, export pins and garbage collection across lifecycle operations.

## 4. Publisher durability and spool lifecycle — M1/M2

- Durable capture before the first remote binding exists, reconciled later.
- Segmented outbox pruning with safe retention of source mappings, filter tails, checkpoints and artifact dependencies.
- Unavailable artifact work must not block unrelated capture/delivery indefinitely.
- Explicit publisher epoch handoff and the remaining lifecycle/recovery fault matrix.
- A single-step `publish --new-stream` (today: `finish`, then `retire`, then `publish`), and a way to start a new recording from the current native position instead of the retained beginning.
- Actual laptop suspension and long offline periods within documented capacity limits.

## 5. Multi-session server and access lifecycle — M2/M5/M6

- Retention, deletion tombstones, read/export pins, server content collection and operational quotas.
- Scale historical indexes and session recovery with measured heap/descriptor/socket limits.
- Safe operational metrics and concurrent load/failure testing.

## 6. Portable recordings and standalone release — M5

- Broader archive failure and version acceptance; derived snapshot/content entries are omitted by the current format.
- Compatible recording-format upgrades and tested rollback.
- Docker/Compose and HTTPS proxy validation on an actual target host and remaining architectures.
- All four adapters through the standalone installation; Windows/WSL support statement.

## 7. Centralized service and deployed pilot — M6

- Per-account quotas, operational monitoring without event bodies or credentials in logs, report archival.
- Deploy behind HTTPS with durable storage and backups; validate concurrent independent publishers/viewers, latency, restart and restoration on the actual host.

## 8. Release acceptance and publication — M7

- Run the cross-client fault matrix and publish measured latency, throughput, seek, memory and disk limits.
- Provenance/signing, npm publication of `agentlive` and repository release notes.
- External testers complete publish → watch → rewind → catch up → replay in both deployment modes.
