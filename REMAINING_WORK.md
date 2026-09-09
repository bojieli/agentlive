# Remaining work toward the full AgentLive goal

Audited 2026-09-10 against implementation plan sections 6–15, current source, CLI commands, and probe evidence. CI confirms macOS/Linux checks and package verification through `2bcb9ca` (bounded local seek catalogs); preceding paired-checkpoint and paged-feed commits are also confirmed. The current paired server-snapshot work has local validation; its CI is not yet confirmed. This inventory preserves the full M0–M7 objective. Historical checkpoint notes establish individual changes, not completion of an entire milestone.

The paired server-snapshot implementation passes the 340-test suite in 49 files plus a focused regression for first mentions preceding agent creation. Native Claude and Kimi probes also verify the production paged session through receipt, seek, saved-presentation reopen and return to live. A real two-turn Kimi resume probe verifies 35 events and 19 persisted activity rows against independent disk and reference ordering. Standalone package installation/rebuild verification passes. Native import/live/recovery probes cover all four agents across the recorded work; Kimi and Codex probes additionally verify actual paged event reduction with checkpoint recovery. All 12 retained OpenCode exports also pass paged reduction and reconstruction. CI status is distinguished above from these local results. The latest corpus run passed 2,564 of 2,599 examined files; 35 Claude files lacked native identity/timestamps. Successful conversions still contain explicit capture gaps and unavailable artifacts. Test counts establish checkpoint behavior, not milestone completion.

## 1. Scalable playback and complete viewers — M1/M4

- Complete shared snapshot-client adoption for browser seeking and paged reducer adoption for terminal state/seeking. The saved-history browser path now uses paged receipt, indexed rows and independent history-range seeking. Production server snapshot generation now stores paired reducer/activity roots and resumes both from a prior paired checkpoint. It now applies every protocol event kind using persistent maps and text references; viewer adoption and measured memory bounds remain required.
- Integrate the implemented revision/version-bound snapshot manifests and authorized snapshot/content endpoints into client seeking. Snapshot-plus-suffix equivalence is tested; automatic scheduling, batching and measured scalable generation remain required.
- Complete snapshot-assisted browser seeking and paged terminal reconstruction; verify scalable behavior and replace the reference fallback/terminal 64 MiB in-memory ceiling. Browser backward seeking now uses a bounded local checkpoint catalog, but falls back to zero when no eligible prefix exists; missing historical suffixes require server access.
- Finish persisted inspection choices (expansions, text pages, attachment selection), richer diff/inspection layouts, idle compression, and remaining terminal replay/step/resize behavior.
- Extend search to paged content and historical versions where required; current search covers the selected canonical snapshot.
- Verify desktop/mobile layout, keyboard/screen-reader behavior, actual browser storage, quota eviction, crashes, suspend/resume, and focus/scroll recovery. Browser discovery was checked again on 2026-09-10 and returned no connected browsers; these checks remain outstanding.
- Measure the plan's long-session and memory targets, including an eight-hour/500,000-event seek workload.

Content-store foundation: TextStore pages/manifests and bounded verified range reads now have restart, real-process-death, corruption, quota, cancellation, queue, and ownership-drain tests, plus reopened reads of real native-session text. An initial paged snapshot codec/reader now preserves the reference state with version/revision/boundary validation and bounded metadata/text range reads. Reopened real Claude snapshot equivalence is verified. Server snapshot publication/selection, authorized bounded HTTP reads, and a shared client with strict response/boundary validation are implemented and exercised on a native recording. Viewer integration, automatic scheduling, safe content collection, and measured scalable generation remain incomplete. A content-addressed key index now supports bulk construction, lookup, bounded ranges, and copy-on-write updates/deletion with historical roots. TextStore also supports immutable append with exact complete-write identity and bounded tail loading. OrderedContentMap adds persistent insertion order, numeric/string key handling and cross-index validation. The new paged reducer uses these primitives for incremental updates and has a distinct versioned checkpoint format. Production server snapshots now use paged reduction with paired activity-index roots, and the shared client dispatches legacy/state-only snapshots as well as paired paged snapshots. Indexed server rows and positions are validated over HTTP against native reference replay. The shared client now supports a bounded IndexedDB snapshot-range cache with integrity checks and reopen validation. A writable IndexedDB content backend now shares the filesystem text codec and can persist paged reducer updates. BrowserPagedState now persists completed reducer roots with atomic compare-and-set publication and reopens from the saved head. The activity feed now accepts frozen paged card projections, including direct workflow links and paginated attachment versions; its text component reads immutable ranges asynchronously. A persistent seen/visible activity index now supplies bounded row ranges and direct position lookup. Browser state and activity roots now have paired atomic publication and legacy-prefix rebuilding in the working implementation. ActivityFeed now supports indexed viewport ranges and paged search when supplied a frozen view. The production browser now selects BrowserPagedSession when saving is enabled: receipt, presentation and indexed feed use paged state. A bounded catalog now retains paired receipt landmarks and explicit seek positions, without advancing receipt for a historical selection. Shared snapshot/local-content bridging, offline historical replay, snapshot scheduling/performance, actual interaction validation and measured memory bounds remain required. The memory-only browser fallback and terminal still use the reference reducer.

## 2. Complete native-agent integration and fidelity — M0/M3

- Finish clean native-session discovery and attach/managed-launch workflows, including installation/uninstallation of any supported integration hooks.
- Associate parent and subagent histories across files, preserving identities, relationships, and resume lineage. Current single-file bindings do not merge the entire workflow.
- Complete active-turn crash recovery, interrupted tools, approval/cancellation, subscription/authentication failures, and source rotation/truncation scenarios across all four agents.
- Complete supported native delta capture; OpenCode's current reconciliation preserves observed snapshots and does not establish capture of every native delta. Interpret native revert metadata.
- Resolve remaining source-object gaps and missing-identity histories where source evidence permits; otherwise retain explicit capability limits.
- Define frozen-import finalization for unfinished OpenCode text: active secret-prefix tails are intentionally withheld, so a frozen recording can omit that pending suffix until a later native completion.
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
