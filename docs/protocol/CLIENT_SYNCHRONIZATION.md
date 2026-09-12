# Client synchronization contracts

Implemented in `@agentlive/client` and `@agentlive/publisher`; UI and persistent subscriber caches remain in progress. These engines use the same server endpoints exercised in integration tests.

## Subscriber receipt

Construct `SubscriberClient` with the server origin, recording ID, revision, and cursor associated with the consumer's restored state. Cursor zero requires empty state. A cursor alone does not restore messages, tools, or artifacts.

`run(signal)` exchanges optional local authorization for a scoped one-use viewing ticket, opens a WebSocket, and subscribes. Tickets live 60 seconds and are used immediately. The server's pending-ticket table is partitioned: one recording holds at most 64 and unauthenticated requests at most half the table, and a request over its share recycles the oldest ticket in that share rather than being refused. A flood of anonymous requests on one public recording therefore costs that recording's own share a retry, and never blocks tickets for other recordings. The subscription response freezes a history boundary while live delivery is registered under the server's session writer. The client downloads complete JSONL pages through that boundary and retains later live events within a byte budget. If that buffer overflows, it retains the observed high-water mark and retrieves missing events from history. It never skips to the newest live event across a sequence gap.

The consumer's asynchronous `commit(events, cursor)` is the transaction boundary: persist the applied state and corresponding receipt cursor atomically, then resolve. The engine advances its own receipt only after this succeeds. A rejected commit stops synchronization visibly. If the consumer commits durably but fails before reporting success, it must restore the durable checkpoint before restarting the engine. Persisted receipt remains distinct from playback position, which can be paused or seeking while new events arrive.

Network failures trigger bounded jittered retries. A new subscription starts from the last committed cursor and checks the recording revision and history boundary. Changed revisions, cursors beyond available history, malformed pages, and access denial fail explicitly. Replacing cached state requires an explicit caller action. Aborting `run` closes the transport and waits for an already-running consumer commit; consumers must make their own storage operations finite.

The engine uses standard fetch and WebSocket interfaces and has no Node runtime dependencies. Current integration tests run Node's native WebSocket. Browser storage, mobile lifecycle, background throttling, and browser rendering still require their acceptance tests.

## Publisher recovery

`PublisherJournal` owns the persistent native-session binding, producer epoch/sequence, captured events, sharing flag, and server ACK. `PublisherNetwork` owns a replaceable WebSocket connection and runs independently of native-agent execution. Before initial capture, `ensureRemote(signal)` currently creates/binds a remote recording using the journal's persisted creation request and secret. A lost creation response can be retried without creating a second recording.

Each reconnect durably increments the connection attempt before requesting a server lease. The resume ACK must match the stored revision and epoch and lie within the locally captured prefix without regressing a previously durable ACK. Otherwise publishing stops with an explicit protocol error. Valid ACKs are persisted; unacknowledged journal events are sent in order in batches of at most 100 events and 256 KiB. Only one batch is in flight. The publisher does not scan its history while idle with no pending events.

A server outage leaves the native capture journal intact. Once a binding exists, capture can continue offline and the pump sends that backlog when the server returns. Paused sharing persists across process restart; the network loop does not create a recording or publish backlog until sharing resumes. Events already in flight when pause is requested can have committed remotely.

Initial capture without a remote binding, segmented journal pruning, automatic attachment dependency uploads, expired creation-request recovery, epoch handoff, and explicit finish/reopen client operations remain required work. The transport does not silently generate replacement recordings to bypass these conditions.

## Verified scenarios

The test suite exercises actual local HTTP/WebSocket listeners and temporary filesystem stores:

- Paged history followed by live delivery, including buffer eviction with a slow state consumer.
- Dropped viewer sockets and restored receipt cursors without repeated state application.
- Failed state transactions, truncated history, changed revisions, and invalid ahead-of-server cursors.
- Private sessions and ticket exchange without long-lived credentials in WebSocket URLs.
- Lost creation responses, publisher restart after a lost durable ACK, and persistent paused sharing.
- Publisher-to-server-to-subscriber delivery and automatic recovery after server downtime while new events are captured.

These synthetic integration tests complement the live-agent transport probes. They do not establish production adapter normalization or native-session recovery, which still need the full live-agent scenario matrix.

## Large text replacement

The native corpus contains source records larger than a publish batch. Normalizers split large appends and use `text.replacement.started`, ordered `text.replacement.chunk`, and `text.replacement.completed` for large final message text, tool input/output, and file patches. The replacement targets text fields only; it cannot introduce attachment references or server lifecycle operations. Each chunk has a durable event sequence and stable source-effect identity. The reducer preserves the previous value until every declared part is present, then switches to the reconstructed value. It rejects missing/out-of-order chunks and excessive pending replacement data. Subscriber checkpoints must include unfinished replacements alongside their receipt cursor.

The current reference reducer bounds unfinished replacement text to 32 × 1024 × 1024 UTF-16 code units and 16 simultaneous replacements. It still holds completed message/tool state in memory; paged production state remains required. Chunking makes transport/storage records bounded and preserves content, but is not by itself a complete large-history viewer implementation.

## Object reopening and presence

`message.reopened` changes an existing completed message to active while retaining its text. `tool.reopened` changes an existing terminal tool to running, retains its input, and clears its previous terminal output. Reopening an already active object is a protocol conflict; transport retries must be deduplicated before reduction.

`object.visibility` addresses an existing message, tool, or attachment by object type and ID. Setting visibility false preserves its history and attachment versions while excluding it from current pending-work presentation. Setting it true restores the same object. Attachment updates preserve visibility. Legacy events without visibility fields remain visible by default.

OpenCode capture records these transitions durably and reconstructs missing checkpoint state from its journal during upgrade. Source absence is distinct from session ending. Native revert metadata is not yet interpreted; these events currently reflect presence in reconciled snapshots.

## Completeness notices

`capture.completeness` records, in normal publisher history, that the recording contains work the native source never finished. Payload version 1 is `{ version: 1, reason: "frozen-native-source", unfinishedMessages, unfinishedTools, withheldTextMessages }`. Version 2 adds `runningTasks`, `pendingInteractions` and `pendingAttachments`. Both are strict: bounded non-negative counts and a fixed reason, never content, identifiers or secret material. Readers accept both versions; version 1 notices say nothing about tasks, interactions or attachments. Native importers emit at most one, as the final imported event before the server ends the recording (see [converter-migrations.md](../converter-migrations.md#import-completeness-notices)).

Both reducers keep the latest notice as optional `completeness` state with its server sequence (`at`). A later notice replaces it and `recording.reopened` clears it, because continued capture may finish or reconcile the counted work. States of recordings without the event have no `completeness` key, so their paged roots and checkpoints keep their previous canonical bytes. The activity index adds no row for the event.

Terminal event/snapshot output and the browser feed render the persisted notice. Separately, at an ended boundary without a persisted notice, viewers derive an "incomplete activity" notice from visible messages that never completed, visible tools still running, tasks whose status is `running`, interactions whose status is `pending` and visible attachments still pending (the same rules as version 2 import counts); the derivation is presentation-only and never appended to history. The reference and paged terminal renderers count every object. The browser paged view checks at most the 2,048 most recently inserted entries of each of those five maps and reports a lower bound ("at least") when a map is larger; a bounded scan that finds nothing shows no notice. Open boundaries are still capturing, so they do not get derived notices.

## Independent terminal presentation

The terminal watcher advances receipt after subscriber-cache commit, independently of its renderer's applied sequence. Presentation reads a fixed cache range and then waits for a durable append notification. A paused renderer or unresolved asynchronous output write leaves receipt running; resumption consumes the retained prefix in order. No rendered-text backlog is queued in memory.

Cancellation stops admission to both loops and releases the cache lock after accepted cache work and cleanup drain. The watcher bounds the caller’s wait with `cancellationTimeoutMs` (default 30,000ms), exposed as `watch --cancellation-timeout-ms`. Expiry rejects with `CancellationTimeoutError` (`code: "cancellation_timeout"`) while retaining ownership until cleanup finishes; `error.whenDrained` reports eventual completion or failure. A timeout never authorizes a second writer to open the same cache. A custom output sink receives the cancellation signal; an unresolved sink is not awaited indefinitely during shutdown. Output that already entered an external sink may finish later, and synchronous blocking work still blocks the shared Node event loop. Cache quota exhaustion and renderer memory limits remain explicit errors. A durable receipt is not proof that every event has been semantically rendered; renderer errors preserve the cached evidence for recovery.
