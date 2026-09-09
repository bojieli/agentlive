# Published browser paged state

`BrowserPagedState` owns a BrowserContentStore and PagedReducer. It loads a saved checkpoint on open, reduces bounded contiguous event batches and publishes a new root only after the whole batch succeeds. It retains the current root and checkpoint descriptor, not the event prefix or completed text. Named object/range and text reads remain asynchronous and bounded by the underlying stores.

## Publication and concurrent writers

BrowserContentStore stores one checkpoint pointer per normalized server/stream/revision namespace in its metadata store. Publication validates the root's format, recording binding, sequence and timeline before an IndexedDB compare-and-set transaction. It checks the complete expected descriptor against the current pointer. A divergent stale writer receives `event_conflict`; it must reopen and reconcile against the current head. An exact retry of an already published descriptor succeeds. Publication cannot replace a sequence with a different root or move the head backward.

This pointer represents the latest locally reduced history, not a user's paused viewport. Seeking needs separate historical checkpoints or reconstruction and must not roll this head backward.

Page writes and pointer selection are separate transactions. Failed reduction or cancellation can leave unreferenced immutable content, but cannot publish a partial batch. Cancellation during the pointer transaction aborts it. Cancellation observed after a commit can leave the caller uncertain; reopen to discover the saved head rather than assuming rollback. The reducer root is updated in memory only after publication resolves successfully.

Root metadata is validated before publication/open; referenced objects and text are checked when visited. The state manager builds roots from completed local reducer writes. A valid root envelope alone is not a full corruption audit of every descendant. Server identity/revision authorization must still be revalidated before using this cache for reconnect.

## Admission and recovery

At most 16 batches are admitted, each with at most 256 events and 1 MiB of encoded batch data. Accepted events are copied before queueing. A failed batch does not advance the in-memory root or saved pointer. Close cancels reduction, drains the queue and then closes the content store. Returned state and descriptor accessors are detached copies.

Tests cover reopening and suffix continuation without the event prefix, failed batches, divergent simultaneous writers, idempotent publication, recording/boundary validation, backward publication rejection and cancellation inside the root-write transaction. Native verification reopens using the saved pointer and checks its state against filesystem and reference replay.

Production BrowserSession still needs to use this state manager for receipt and asynchronous viewport reconstruction. Snapshot import into local content, historical checkpoint selection, eviction recovery and actual browser/device validation remain required.
