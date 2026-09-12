# Recording snapshots

Snapshots are derived acceleration data. The JSONL event log remains authoritative. All routes below are relative to `/api/v1/streams/:id` and require the current recording revision. Responses use `Cache-Control: no-store`.

## Publish a snapshot

`POST /snapshots`, with an owner or recording publisher bearer credential:

```json
{ "revision": "recording-revision", "throughServerSeq": 1200 }
```

The sequence must be within the committed history. The server opens the latest earlier paged checkpoint when available, reduces only the remaining contiguous event suffix, persists the new root, then atomically publishes its catalog descriptor. Without a paged checkpoint it reduces the requested prefix from the JSONL history. Appends may continue while the snapshot builds. A successful response has status 201:

```json
{
  "streamId": "recording-id",
  "revision": "recording-revision",
  "snapshot": {
    "format": "agentlive.paged-state",
    "serverSeq": 1200,
    "timelineMs": 45000,
    "ref": {
      "hash": "64 lowercase hexadecimal characters",
      "byteSize": 123,
      "units": 456
    }
  }
}
```

Reference sizes in this example are illustrative. `byteSize` describes the encoded TextStore manifest, while `units` describes the decoded string's UTF-16 length. Retrying a retained sequence returns its verified existing descriptor. Cancellation before catalog commit may leave reusable, unpublished content. Once atomic commit starts, a disconnected caller must check selection/retry rather than infer that publication was rolled back.

## Select a snapshot

`GET /snapshots?revision=…&throughServerSeq=1200`

Uses the recording's existing read-access policy. Returns the same envelope as publication, with the newest retained descriptor whose sequence is at or before the target, or `snapshot: null`. It verifies the selected manifest's recording binding and sequence/time against the catalog. A missing snapshot allows full event replay; corruption is reported explicitly.

Load a selected snapshot at its exact sequence, then request contiguous events strictly after that sequence through the desired target. Never combine revisions. The production browser and terminal do not yet perform this snapshot-based reconstruction automatically.

## Read snapshot content

`GET /snapshot-content/:hash?revision=…&byteSize=…&units=…&offset=…&length=…`

Uses the recording's read-access policy and its isolated TextStore. Supply the complete content reference and a range within its decoded UTF-16 units. A read is limited to 65,536 units. The server verifies stored identity and length before returning `{"text":"…"}`; JSON preserves lone surrogate units when a range splits a pair. The endpoint serves decoded ranges, not cryptographic range proofs for independent verification against an untrusted server. Use the authenticated same-origin transport and HTTPS deployment policy.

`openRecordingSnapshot` dispatches by the descriptor format. Descriptors without a format retain the original `SnapshotReader` codec. New `agentlive.paged-state` descriptors use `PagedSnapshotReader`, which exposes named object lookup/ranges and text-reference range reads. Mismatched formats are rejected without fallback. Paged object metadata is capped at 2 Mi UTF-16 units and read in chunks of at most 65,536 units; object ranges contain at most 32 entries. Full `materialize` is a bounded reference/testing helper, not a production long-history loading strategy.

## Current limits and lifecycle

- Snapshot generation uses the persistent paged reducer and no longer imposes the transitional 64 MiB cumulative-history limit. TextStore capacity and per-event/object limits still apply. Per-event write amplification, batching and measured long-session bounds remain required.
- Each recording admits at most 16 snapshot operations and uses a default 512 MiB encoded TextStore quota.
- Catalogs retain the highest 128 snapshot sequences. Automatic collection (below) prunes that catalog to the roots it retains and reclaims everything else.
- Snapshot catalog/content operations are serialized per recording. Event publishing uses its separate existing queue.
- Shutdown drains accepted snapshot writes before releasing ownership. A caller deadline never permits a second uncertain writer.
- Read-only credentials, rotation/revocation and production viewer loading remain separate work.

## Automatic collection of superseded content

Building a new boundary supersedes the previous one, so a long recording accumulates intermediate paged-state versions. The server reclaims them automatically. **A pass retains exactly three things, frozen together for its whole duration:**

1. the published head the server would select — the newest catalog descriptor;
2. every unexpired lease in the recording's durable lease ledger, traced from the lease's own copied paired roots;
3. every in-process read/export pin held by an accepted operation (`ContentPins`), including exact raw-blob pins.

The whole pass runs inside the recording's publication/lease queue, so a snapshot publication, lease acquisition, renewal, release or leased content read requested during a pass **waits** and runs after it; none of them can be swept, and none can add a root the pass did not see. Unleased snapshot content reads are held off by the pin retention barrier meanwhile and receive a retryable `retry_later` (HTTP 503); retry, or hold a lease. The pass also runs as a shared holder of the server write barrier, so an online backup cannot start in the middle of one; if a backup asks for the barrier while a pass is running, the pass cancels itself rather than making the backup wait, and a pass requested while a backup is pending is refused with `retry_later`.

Order inside a pass: every retained root is opened and verified, the catalog is atomically rewritten to exactly the retained descriptors, and only then are unreferenced encoded blobs swept. So selection can never return a descriptor whose content was reclaimed, and a process death mid-sweep leaves a store that reopens with every retained root readable; the abandoned mark set is discarded under the store lock and the pass can simply be retried. A cancelled or failed trace deletes nothing. A catalog holding a descriptor this collector cannot trace (a legacy pre-paged format) makes the pass skip without deleting anything.

**Consequence for clients:** older descriptors stop being selectable and their content stops being readable once a pass runs. A viewer that must keep reading one exact checkpoint across time must hold a lease on it (`selectLeased`/`renewLease`, see the client API above). A lease pins that checkpoint's paired roots byte for byte until it expires or is released.

Scheduling shares the single snapshot worker with automatic builds (one job at a time, rotation, backoff). A due build always wins; a collection pass becomes due for a recording when its encoded snapshot storage has grown by `collectGrowthBytes` (default 64 MiB) since that recording's last completed pass **and** at least `intervalMs` (default 30 s) has elapsed since it, so idling alone never triggers one. One pass is bounded by `collectTimeoutMs` (default: the build `timeoutMs`, 30 s). A failed or cancelled pass is counted and retried no sooner than the next interval. `agentlive serve --no-snapshot-collection` (library: `snapshots: { collect: false }`) disables it entirely; collection is **enabled by default**.

Operational counters in `/metrics`: `agentlive_snapshot_collections_active`, `agentlive_snapshot_collections_total`, `agentlive_snapshot_collection_failures_total`, `agentlive_snapshot_collection_reclaimed_bytes_total` and `agentlive_snapshot_collection_last_duration_seconds`.

## Shared client API

`RecordingSnapshotClient` is exported by `@agentlive/client`. Construct it with `serverOrigin`, `streamId`, `revision`, and an optional `credential`. An optional fetch implementation supports embedding and verification.

```ts
const snapshots = new RecordingSnapshotClient({
  serverOrigin,
  streamId,
  revision,
  credential,
});
try {
  const selected = await snapshots.select(targetSequence, sessionSignal);
  if (selected) {
    const { descriptor, reader } = selected;
    if ("format" in reader && reader.format === "agentlive.paged-state") {
      const messages = await reader.entries("messages", 0, 32, sessionSignal);
      // Load selected message.text references with reader.text(ref, offset, length).
    } else {
      const fields = await reader.entries(
        reader.manifest.state,
        0,
        32,
        sessionSignal,
      );
      // Resolve legacy containers through the original snapshot reader.
    }
    // Continue events strictly after descriptor.serverSeq.
  }
} finally {
  snapshots.close();
}
```

`publish(sequence, signal)` requires owner/publisher credentials and returns the same `{ descriptor, reader }` shape. `select` can return null. The client validates the server envelope and opens the bound root before returning a reader. The descriptor is frozen. An opening signal governs that reader's subsequent network access, so use a session-lifetime signal when retaining a reader. `close()` aborts outstanding and future transport requests; already decoded local values remain ordinary data.

Each operation makes one attempt, with a 30-second deadline per HTTP request and at most 16 concurrent requests per client. Retain the revision/target when retrying a network failure. Binding changes and corruption require explicit recovery, not silent fallback to another recording. Responses are bounded before parsing: 4 KiB for selections/publications, and six bytes per requested UTF-16 unit plus 4 KiB for content. Aborting or rejecting an oversized response does not wait indefinitely for the underlying stream's cancellation callback.

This client does not yet replace browser or terminal replay reconstruction with paged state, and its materialization helper remains for bounded verification.

### Reader formats

The shared client returns a reader whose `manifest` supplies the verified recording boundary and whose `materialize` helper supports bounded equivalence checks. For paged descriptors, narrow the reader using its `format` property before calling `get("messages", messageId)` or `entries("messages", offset, limit)`. Message text and tool input/output are content references; pass a reference to `text(ref, offset, length)` to load a bounded range. The paged reader's `state` accessor returns a detached root copy for subsequent local reduction; mutating it does not change the reader.

Old catalog entries remain selectable and readable. Building a new boundary after a legacy checkpoint replays authoritative history into paged state; it does not materialize and convert the legacy snapshot. Retrying an existing legacy boundary returns that same descriptor.

### Optional range persistence

Pass `cache: SnapshotReadCache` when constructing the client to reuse exact verified ranges. The browser implementation is described in [BROWSER_SNAPSHOT_CACHE.md](BROWSER_SNAPSHOT_CACHE.md). Selection/publication remains a network operation. Cache keys include recording revision and full range identity; caller cancellation and client close prevent cached reads too. Cache failures disable the cache for that client and fall back to the network. The client does not own the supplied cache; its creator must close it.
