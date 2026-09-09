# Immutable content index

`ContentIndex` in `@agentlive/playback` supplies the key lookup and persistent metadata updates needed by paged reducer state. It uses the same `SnapshotContent` interface as snapshots, with TextStore providing durable writes and verified reads.

An index root is null for an empty index, or `{ ref, count, first, last }`. Its versioned node contains ordered leaf entries or branch descriptors. Values are opaque content references: looking up a key does not load its text or object payload.

| Operation | Result |
| --- | --- |
| `build(sortedEntries, signal?)` | Build a root in one pass from a strictly increasing iterable of keys. |
| `get(root, key, signal?)` | Return its content reference, or undefined if absent. |
| `entries(root, offset, limit, signal?)` | Return up to 32 entries in key order. |
| `set(root, key, reference, signal?)` | Return a root with the entry inserted or replaced. |
| `delete(root, key, signal?)` | Return a root without the key, or null when empty. |

Mutations preserve old roots and rewrite the affected path. Splits account for JSON escaping as well as entry count. Deletion prunes empty nodes and collapses unary roots; internal nodes may remain sparse. Initial bulk creation writes complete pages and keeps bounded groups per level instead of rewriting a root for each inserted key. Duplicate or unsorted bulk input is rejected.

Keys are strings of at most 512 UTF-16 units, ordered with JavaScript string comparison. Nodes have at most 32 entries or children, with a maximum encoded JSON length of 32,768 UTF-16 units. Traversal depth is limited to 64. Each loaded node validates its version, ordering, count, key bounds and complete references against the requested descriptor. Validation is lazy: unrelated subtrees and value payloads are not read merely to access one key.

The caller must supply durable value references, retain the chosen root, and atomically publish it within the recording's revision-bound metadata. The index neither selects between concurrently created roots nor performs deletion/garbage collection. Cancellation can leave unreachable durable nodes, but cannot return a newly changed root after it observes the abort. Existing roots remain usable through their content provider.

This key order does not encode native Map insertion order. The paged Map/reducer layer must add ordering and source-key handling, then integrate the index into snapshots. Current production snapshots and viewers still use their existing state representation; this library is their storage prerequisite, not a new viewer mode or completed scalability gate.


`rank(root, key, signal)` returns an existing key's zero-based position or undefined. It follows the key path while summing verified preceding subtree counts; it does not enumerate those rows or load value content. Reopened 1,100-entry coverage checks rank before/after deletion and bounds the lookup to four metadata reads. ActivityIndex uses this operation for row navigation.
