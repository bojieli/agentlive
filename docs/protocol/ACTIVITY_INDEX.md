# Persistent activity row index

ActivityIndex derives display rows from canonical events and their corresponding paged reducer state. It uses two immutable ContentIndex trees: one remembers first mentions by object key, and the other contains visible rows in display order. A row update touches the affected index paths; it does not enumerate the recording's objects or load their text. Text-only and completion/reopen transitions that require an existing object and preserve visibility advance the sequence without reading or writing the row trees.

First mention is tracked for supported object identity fields, including artifact descriptors carried by attachment.available. Objects mentioned before their own lifecycle record retain their earlier position when they become available. At equal first sequence, kind ordering matches activityRows. Capture notes remain at the end in capture order. Hiding an object removes only its visible entry; showing it again restores its original position.

The existing BrowserSession ordering helper now shares activityMentions. This also gives an artifact introduced directly by an availability event a recorded position, rather than leaving it at the unknown-order fallback.

## Reads and integrity

`entries(root, offset, limit)` returns at most 32 row identities. `position(root, key)` resolves an existing visible row's position through subtree counts, without reading all earlier rows. Missing/hidden rows return no position. The underlying ContentIndex rank operation preserves historical roots and respects deletion counts.

Visited rows validate kind, ID, first sequence, visibility and gap ordinal. Both index references are cross-checked before exposing a row. This detects mixed seen/visible roots for visited records. Checkpoints use the agentlive.activity-index format, version 1, bound to stream ID and revision. Metadata reads/writes are capped at 32,768 UTF-16 units and no row value contains recording text.

Apply the next contiguous event only after its paged state is available. The resulting index root records that same sequence. Cancellation may leave unreferenced derived nodes but leaves the input root usable. The caller must atomically publish the reducer and activity-index roots together; this class does not select a mutable head itself.

## Evidence and remaining integration

Tests cover first mentions before object creation, direct attachment introduction, capture-note order, visibility restoration, checkpoint reopen, mixed-root rejection, bounded row ranges, cancellation and position lookup. ContentIndex rank is also tested across its reopened 1,100-entry tree and a deletion. Native verification builds/reopens the index and compares every row key and position with reference activity ordering.

Production browser checkpoint pairing, feed row queries and navigation still need to adopt this index. Existing row enumeration and search remain in memory. Historical indexes cannot recover first-mention order from only a final state snapshot; creation requires the corresponding event history or a previously paired activity checkpoint. Long-session performance and collection/pinning remain required.
