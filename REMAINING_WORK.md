# Remaining work toward the full AgentLive goal

Updated 2026-09-11. The current verified state and gate table are in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). The previous inventory and its checkpoint notes are preserved verbatim in [docs/history/remaining-work-log.md](docs/history/remaining-work-log.md). No individual item closes an M0–M7 gate by itself.

## Execution order

The user-directed order remains: finish missing product features, then performance/capacity and lifecycle hardening, then broad acceptance and publication. Benchmarks stay paused until feature work is complete.

1. **Converter/filter migration.** Frozen-import replacement, source relocation, cross-server replacement (import *and* live binding), archive lineage, archive-only server transfer and live-binding replacement for all four agents (with an abandon path that recognizes a lost family child, and a fence covering both `publish` and `import` at the source and destination keys) are implemented. Still open: compatible in-place continuation under a new converter without a replacement recording.
2. **Native fidelity and artifacts.** Completeness notices now cover unfinished messages and tools, running tasks, pending interactions and pending attachments (payload version 2). Close remaining per-agent source gaps where evidence permits (see [compatibility](docs/compatibility.md)), broaden media/module/HTML fidelity, and define frozen-import finalization for withheld OpenCode text tails.
3. **Hosted authorization follow-ups.** Per-account quotas are implemented (usage display in the browser and an account-facing usage command remain optional); real identity-provider acceptance; concurrent logout/disable race coverage beyond the tested revocation points.
4. **Operations.** The data-format marker and newer-format refusal are implemented; the first real format migration and automated rollback orchestration remain. Online backup is implemented and passes the container probe; exercise it on an actual host.
5. **Performance, capacity and lifecycle.** The synthetic 500k / eight-hour memory workload now completes; still needed: bounded far-seek latency (cheaper landmarks or faster replay), realistic mixed-payload and IndexedDB/server-snapshot measurements at that scale; retention policy; safe automatic server content collection; independent artifact delivery; report archival; suspension/device/accessibility acceptance.
6. **Release acceptance and publication.** Current-release CI, package and container verification; deployed pilot; npm publication with provenance through the prepared [release workflow](RELEASING.md) (needs an `NPM_TOKEN` in the `npm` environment and a version tag); external testers completing publish → watch → rewind → catch up → replay in both deployment modes.

## 1. Scalable playback and complete viewers — M1/M4

- Long-session playback: the 500,000-event memory fixture completes (94 s, generational collection), but far seeks can take about 13 s under the 64 MiB quota; one-second seeks need faster replay or cheaper landmarks. Packing single-page text into manifests would halve blob counts but needs a versioned codec change. See [performance](docs/performance/README.md).
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

## Security review follow-ups

The 2026-09-12 review probed the authorization layer route by route and found it sound; all four of its findings are fixed. What remains is design limits worth restating rather than defects:

- Redaction is exact-substring over the named values, so encoded (base64, percent, JSON-escaped), case-shifted, split or derived copies of a secret survive, and a secret inside a compressed or nested container is not reached. Scope — which artifact roots a publisher allows — is the primary control, not filtering.
- Spool directories that already captured artifacts keep the pre-2026-09-12 redaction rule so their retries stay idempotent; only new bindings get byte-based redaction. Consider an explicit migration for long-lived publishers.
- Every capture is now checked against the publisher's own dictionary before it is written, over the whole encoded event rather than the fields an adapter treats as text, and a hit stops the publisher. That enforces the exact-value rule below the adapters; it does not make a field-by-field audit unnecessary for encoded, split or derived copies, which the dictionary cannot match.
- Watch-ticket and abuse-report tables are fillable by anonymous viewers of public recordings (bounded and self-healing, but they can block new tickets or reports meanwhile).

## 4. Publisher durability and spool lifecycle — M1/M2

- Import bindings keep the whole converted journal: the completeness notice is computed by reducing the full captured prefix at the end of an import, so nothing can be pruned while one runs. That prefix is bounded by the native transcript, and resuming the import live puts the binding under normal retention, but a finished, never-resumed import still holds a copy of everything it converted.
- Unavailable artifact work must not block unrelated capture/delivery indefinitely.
- Explicit publisher epoch handoff and the remaining lifecycle/recovery fault matrix.
- A way to start a new recording from the current native position instead of the retained beginning. `publish --new-stream` is implemented; cutting at the native tail is not, because a projection starting mid-object emits appends whose objects never started, which the reducers reject. It needs a per-adapter safe-boundary rule.
- Actual laptop suspension and long offline periods within documented capacity limits.

## 5. Multi-session server and access lifecycle — M2/M5/M6

- Past its fan-out knee (~51,000–60,000 deliveries/s measured) the server queues rather than sheds. It now *says* so — readiness, metrics and refusal of new viewers on event-loop delay or aggregate socket backlog — but the knee itself is unchanged, and the published load rows were measured before the signal existed and have not been re-measured with it.
- Automatic snapshot builds hit their 30-second deadline under that saturation, so snapshot freshness degrades exactly when a recording is busiest; only a metrics counter reports it.
- Durable capture serializes with the delivery loop's read of the same journal and fsyncs per capture, which caps a publisher at ~15 captures/s when many share a volume. Batching hides it; a fast native source would not.
- An event whose reducer preconditions are unmet (an append before its start) is still accepted at publish; the snapshot builder now names it, stops building that recording and reports it through metrics and the owner's publisher-state instead of retrying forever, but paged playback for that recording stays at its last good snapshot and the only repair is republishing the session.

- Retention, deletion tombstones, read/export pins, server content collection and operational quotas.
- Scale historical indexes and session recovery with measured heap/descriptor/socket limits.
- Safe operational metrics and concurrent load/failure testing.

## 6. Portable recordings and standalone release — M5

- Broader archive failure and version acceptance; derived snapshot/content entries are omitted by the current format.
- Compatible recording-format upgrades and tested rollback.
- Docker/Compose and HTTPS proxy validation on an actual target host and remaining architectures.
- All four adapters through the standalone installation.
- Windows support, if wanted: the probe shows install, build and native locks work, but directory fsync is rejected (`EPERM`) and POSIX file-mode/symlink checks have no Windows equivalent. It needs an explicit, fault-tested durability and permission story, not a suppression of the failing calls. WSL is untested.

## 7. Centralized service and deployed pilot — M6

- Report archival and retention policy; alerting and dashboards built on the metrics endpoint; measured behaviour under sustained concurrent load.
- Deploy behind HTTPS with durable storage and backups; validate concurrent independent publishers/viewers, latency, restart and restoration on the actual host.

## 8. Release acceptance and publication — M7

- Run the cross-client fault matrix, and extend [the published limits](docs/limits.md) with concurrent-load latency/throughput and the cached (IndexedDB) playback path at scale.
- Provenance/signing, npm publication of `agentlive` and repository release notes.
- External testers complete publish → watch → rewind → catch up → replay in both deployment modes.
