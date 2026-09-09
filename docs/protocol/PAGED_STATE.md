# Persistent paged reducer state

`PagedReducer` applies canonical stored events to immutable roots backed by `SnapshotContent` plus incremental text append. It covers all event families handled by the reference reducer. Messages, tool input/output and edit patches retain content references; workflow objects are individually stored metadata. Artifact versions and pending replacement chunks have their own ordered maps. Applying an event loads the affected objects and index paths rather than reconstructing the whole recording.

Callers serialize updates, retain content-store ownership through accepted I/O, and atomically publish only a completed root. A failed or cancelled application leaves its input root usable. It may leave unreferenced derivative content; garbage collection and publication pins are separate responsibilities. The authoritative event history remains JSONL.

## Reading and recovery

`get` reads one object. `entries` reads at most 32 objects in insertion order. Text references support verified bounded range reads through the content store. Artifact source-reference keys use a SHA-256 index key and retain the original key in the value; reads verify the association and expose the original key, including references longer than the ordered-map key limit.

`checkpoint` writes a `format: "agentlive.paged-state"`, version 1, reducer-version 1 envelope bound to stream ID and revision. `open` validates this envelope and root metadata; referenced objects are validated as visited. Pending replacements preserve their chunks, aggregate text reference, target and length, so reduction can continue after a checkpoint reopen. Checkpoints do not imply that all referenced content has been eagerly audited.

This format is distinct from the initial `SnapshotReader` format. Server publication now writes paged descriptors and the shared client dispatches explicitly through `openRecordingSnapshot`; descriptors without a format retain the legacy codec. Browser/terminal automatic snapshot use remains required. Substituting one root for the other is invalid.

## Bounds and limitations

Each encoded event is limited to 1 MiB. Object metadata is limited to 2 Mi UTF-16 units and read in ranges of at most 65,536 units. There are at most 16 pending replacements and 32 Mi UTF-16 units of aggregate pending replacement text. TextStore imposes its own per-text and store capacity limits. These limits are admission bounds, not a measured whole-process memory guarantee.

`materialize` is an equivalence-testing helper with a default 16 Mi-unit accounting budget. It reconstructs ordinary reference state and must not be used as the production large-session viewer. Object-range loading can precede budget accounting. Production views must read objects and text ranges directly.

Per-event immutable writes currently retain historical nodes. Batching, content pins/collection, automatic snapshot scheduling and the long-session performance suite remain required.

## Evidence

Recovery tests compare paged and reference state after every event in a matrix covering every protocol event kind, including tool/message reopen, visibility, artifact versions, workflow objects and all replacement targets. They reopen storage during pending replacements, verify previous roots after cancellation, reject invalid transitions and detect mismatched artifact descriptor identities/versions. Long source references are preserved exactly.

Native probe verification reduces captured events, reopens a midpoint checkpoint, and compares the resulting state strictly to native reference replay. The local corpus validator supports `--paged` for the same comparison over retained source histories, with temporary content removed and only aggregate results retained. These checks exercise the reducer library; they do not establish production viewer adoption.
