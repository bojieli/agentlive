# Recording snapshots

Snapshots are derived acceleration data. The JSONL event log remains authoritative. All routes below are relative to `/api/v1/streams/:id` and require the current recording revision. Responses use `Cache-Control: no-store`.

## Publish a snapshot

`POST /snapshots`, with an owner or recording publisher bearer credential:

```json
{"revision":"recording-revision","throughServerSeq":1200}
```

The sequence must be within the committed history. The server reconstructs exactly that prefix, persists the content tree, then atomically publishes its catalog descriptor. Appends may continue while the snapshot builds. A successful response has status 201:

```json
{
  "streamId":"recording-id",
  "revision":"recording-revision",
  "snapshot":{
    "serverSeq":1200,
    "timelineMs":45000,
    "ref":{"hash":"64 lowercase hexadecimal characters","byteSize":123,"units":456}
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

`SnapshotReader` consumes these references, reading metadata pages of at most 32,768 units and container ranges of at most 32 entries. Full `materialize` is a bounded reference/testing helper, not a production long-history loading strategy.

## Current limits and lifecycle

- The reference builder admits up to 64 MiB of cumulative encoded events. This does not establish a 64 MiB heap bound; scalable generation requires the paged reducer.
- Each recording admits at most 16 snapshot operations and uses a default 512 MiB encoded TextStore quota.
- Catalogs retain the highest 128 snapshot sequences. Older descriptors and interrupted builds can leave content on disk; no content is deleted yet. Safe pins, retention and collection remain unfinished.
- Snapshot catalog/content operations are serialized per recording. Event publishing uses its separate existing queue.
- Shutdown drains accepted snapshot writes before releasing ownership. A caller deadline never permits a second uncertain writer.
- Read-only credentials, rotation/revocation, automatic snapshot scheduling, and production viewer loading remain separate work.


## Shared client API

`RecordingSnapshotClient` is exported by `@agentlive/client`. Construct it with `serverOrigin`, `streamId`, `revision`, and an optional `credential`. An optional fetch implementation supports embedding and verification.

```ts
const snapshots = new RecordingSnapshotClient({
  serverOrigin, streamId, revision, credential,
});
try {
  const selected = await snapshots.select(targetSequence, sessionSignal);
  if (selected) {
    const { descriptor, reader } = selected;
    const fields = await reader.entries(reader.manifest.state, 0, 32, sessionSignal);
    // Resolve selected containers/text lazily; continue events after descriptor.serverSeq.
  }
} finally {
  snapshots.close();
}
```

`publish(sequence, signal)` requires owner/publisher credentials and returns the same `{ descriptor, reader }` shape. `select` can return null. The client validates the server envelope and opens the bound root before returning a reader. The descriptor is frozen. An opening signal governs that reader's subsequent network access, so use a session-lifetime signal when retaining a reader. `close()` aborts outstanding and future transport requests; already decoded local values remain ordinary data.

Each operation makes one attempt, with a 30-second deadline per HTTP request and at most 16 concurrent requests per client. Retain the revision/target when retrying a network failure. Binding changes and corruption require explicit recovery, not silent fallback to another recording. Responses are bounded before parsing: 4 KiB for selections/publications, and six bytes per requested UTF-16 unit plus 4 KiB for content. Aborting or rejecting an oversized response does not wait indefinitely for the underlying stream's cancellation callback.

This client does not yet replace browser or terminal replay reconstruction with paged state, and its materialization helper remains for bounded verification.
