# Remaining work toward the full AgentLive goal

Audited 2026-09-09 against implementation plan sections 6–15, current source, CLI commands, and probe evidence. Server snapshot changes have local validation; macOS/Linux CI was confirmed for the preceding shared-client checkpoint `bfd9c38`. This inventory preserves the full M0–M7 objective. Historical checkpoint notes are evidence of individual changes, not proof that an entire milestone is complete.

The project has successful package installation/rebuild verification, macOS/Linux CI on the preceding committed text-store checkpoint, and native import/live/recovery probes for all four agents across the recorded work. The preceding snapshot codec checkpoint passed 267 tests in 35 files, package installation/rebuild verification, and a fresh native Claude import/resume probe. The server snapshot checkpoint passes 271 tests in 35 files and standalone installation/rebuild verification, including installed snapshot publication and content reads. The shared snapshot client checkpoint passes 277 tests in 36 files and package verification, with real Claude and Kimi HTTP snapshot reconstruction. The persistent-index checkpoint passes 281 tests in 37 files, package verification, and a fresh OpenCode resume/import probe with reopened key lookups. Native evidence is documented in the probe record. Test counts are checkpoint evidence, not milestone completion. The latest corpus run passed 2,564 of 2,599 examined files; 35 Claude files lacked native identity/timestamps. Passing conversions still contain explicit capture gaps and unavailable artifacts.

## 1. Scalable playback and complete viewers — M1/M4

- Integrate immutable disk-backed content pages and the new persistent key index with a paged reducer; keep completed text outside the active heap. Insertion-order maps and incremental large-text updates remain required.
- Integrate the implemented revision/version-bound snapshot manifests and authorized snapshot/content endpoints into client seeking. Snapshot-plus-suffix equivalence is tested; automatic scheduling and scalable generation remain required.
- Page browser/terminal history reconstruction and working state; replace the current 64 MiB in-memory playback ceiling with tested scalable behavior.
- Finish persisted inspection choices (expansions, text pages, attachment selection), richer diff/inspection layouts, idle compression, and remaining terminal replay/step/resize behavior.
- Extend search to paged content and historical versions where required; current search covers the selected canonical snapshot.
- Verify desktop/mobile layout, keyboard/screen-reader behavior, actual browser storage, quota eviction, crashes, suspend/resume, and focus/scroll recovery. No browser is currently connected for these checks.
- Measure the plan's long-session and memory targets, including an eight-hour/500,000-event seek workload.

Content-store foundation: TextStore pages/manifests and bounded verified range reads now have restart, real-process-death, corruption, quota, cancellation, queue, and ownership-drain tests, plus reopened reads of real native-session text. An initial paged snapshot codec/reader now preserves the reference state with version/revision/boundary validation and bounded metadata/text range reads. Reopened real Claude snapshot equivalence is verified. Server snapshot publication/selection, authorized bounded HTTP reads, and a shared client with strict response/boundary validation are implemented and exercised on a native recording. Paged-reducer/viewer integration, automatic scheduling, safe content collection, and scalable generation remain incomplete. A content-addressed key index now supports bulk construction, lookup, bounded ranges, and copy-on-write updates/deletion with historical roots. It is not yet used by the production reducer or snapshot format. Snapshot creation still begins with full in-memory reference state; this is not an implemented paged viewer.

## 2. Complete native-agent integration and fidelity — M0/M3

- Finish clean native-session discovery and attach/managed-launch workflows, including installation/uninstallation of any supported integration hooks.
- Associate parent and subagent histories across files, preserving identities, relationships, and resume lineage. Current single-file bindings do not merge the entire workflow.
- Complete active-turn crash recovery, interrupted tools, approval/cancellation, subscription/authentication failures, and source rotation/truncation scenarios across all four agents.
- Complete supported native delta capture; OpenCode's current reconciliation preserves observed snapshots and does not establish capture of every native delta. Interpret native revert metadata.
- Resolve remaining source-object gaps and missing-identity histories where source evidence permits; otherwise retain explicit capability limits.
- Finish converter/filter upgrade compatibility and record an evidence-backed compatibility matrix from the full common scenario suite.

## 3. Complete attachment and artifact portability — M3/M4/M5

- Resolve supported provider-private/authenticated artifact URLs locally, capture their bytes, and rewrite references to AgentLive URLs.
- Implement artifact bundles and dependency rewriting (HTML/CSS/scripts/images/relative links), immutable version capture, and portable resolution with the publisher offline.
- Broaden upload/generated-image/artifact coverage for each adapter; retain explicit unavailable historical versions rather than substituting current files.
- Complete isolated rich previews and additional supported image formats, with bounded loading/decoding and appropriate content isolation.
- Test interrupted/versioned uploads, artifact dependencies, export pins, and garbage collection across lifecycle operations.

## 4. Publisher durability and spool lifecycle — M1/M2

- Capture durably before the first remote binding exists, then reconcile creation and delivery later.
- Implement segmented outbox pruning and safe retention of source mappings, filter tails, checkpoints, and artifact dependencies.
- Prevent unavailable artifact work from indefinitely blocking unrelated capture/delivery while preserving ordered availability events.
- Complete explicit publisher epoch handoff and the remaining lifecycle/recovery fault matrix.
- Verify actual laptop suspension and long offline periods within documented capacity limits.

## 5. Multi-session server and access lifecycle — M2/M5/M6

- Add revocable read-only viewing credentials, publisher credential rotation/revocation, and active-session/transfer invalidation.
- Finish retention/deletion/tombstones, read/export pins, garbage collection, and operational quotas.
- Scale historical indexes/deduplication state and session recovery with measured heap/descriptor/socket limits. Session-cache eviction exists; it does not prove all server memory is bounded.
- Complete readiness/storage checks, safe operational metrics, and concurrent load/failure testing.

## 6. Portable recordings and standalone release — M5

- Implement the versioned `.agentlive` archive exporter/importer with frozen history, attachments, manifests/hashes, validation, and safe bounded archive extraction. Native-session import is already available; portable AgentLive archive support is separate.
- Implement backup/restore, revision handling after restore, compatible format upgrades, and tested rollback procedures.
- Add Docker/Compose or supervised deployment examples, HTTPS/proxy guidance, and clean-machine deployment documentation.
- Validate all four adapters through the standalone installation and complete the platform support statement. Windows/WSL remains unverified.
- Consolidate older README/status statements so shipped commands and limitations are unambiguous.

## 7. Centralized service and deployed pilot — M6

- Add established OIDC sign-in, CLI device login, account ownership/isolation, per-account quotas, and revocation.
- Add retention/removal/reporting workflows and operational monitoring without event bodies or credentials in logs.
- Deploy the same core server behind HTTPS with durable storage and backups; validate concurrent independent publishers/viewers, latency, restart, and restoration on the actual host.

## 8. Release acceptance and publication — M7

- Run the full cross-client fault matrix and publish measured latency, throughput, seek, memory, and disk limits.
- Complete compatibility documentation, contribution/security guidance, license/attribution, sample recording, provenance/signing, and package/repository publication steps.
- Have external testers complete publish → watch → rewind → catch up → replay in both standalone and centralized modes.

## Execution priority

Continue content pages → paged reducer/snapshots → viewer integration and memory verification. Then complete capture/artifact fidelity and publisher lifecycle, portable archives and operational access/storage features, standalone deployment, centralized pilot, and release acceptance. Real browser/device verification should proceed as soon as a browser is available; lack of that surface does not block independent implementation work.

No completion percentage is asserted: the remaining performance, fidelity, deployment, and release gates require different kinds of evidence and are not interchangeable with test counts.
