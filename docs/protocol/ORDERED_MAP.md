# Persistent insertion-order maps

`OrderedContentMap` from `@agentlive/playback` stores an immutable map from supported keys to durable content references. It uses a `SnapshotContent` provider such as TextStore. It reads metadata without loading the value payloads.

| Operation                               | Result                                                 |
| --------------------------------------- | ------------------------------------------------------ |
| `get(root, key, signal?)`               | A content reference, or undefined for an absent key.   |
| `entries(root, offset, limit, signal?)` | Up to 32 key/reference pairs in insertion order.       |
| `set(root, key, reference, signal?)`    | A new root with the value inserted or updated.         |
| `delete(root, key, signal?)`            | A root without the key, retaining its ordinal counter. |

Pass null for the initial empty map. Roots contain `version`, `size`, `nextOrdinal`, `byKey` and `byOrder`. Publish the entire root atomically inside the recording's bound state; publishing one index independently can produce an inconsistent map.

Updating an existing value keeps its position. Deleting and reinserting a key places it at the end. Strings and finite numbers are supported; numeric `1` and string `"1"` are distinct, while `-0` and `0` identify the same entry. String keys are limited to 4,096 UTF-16 units. Object keys, NaN and infinities are outside this recording-state map's key contract.

The lookup index uses SHA-256 of the canonical key representation. An entry retains the original key and its insertion ordinal, so a digest collision or wrong-key reference produces an error. The order index uses a fixed-width ordinal. Both indexes point to the same immutable entry, and reads cross-check their agreement for each visited entry. This validation is lazy; it does not scan the entire map to validate unrelated pages.

Entry metadata is limited to 32,768 UTF-16 units, and the underlying index has bounded pages and traversal depth. Existing roots remain readable after mutations and reopening. A no-op update or deletion writes nothing. A cancelled update can leave reusable orphan content, but returns no changed root after observing cancellation. The map does not manage locking, choose a concurrent fork, publish roots, or collect old pages; those responsibilities belong to the state owner and content provider.

The primitive supports bounded metadata access but is not yet connected to production event reduction or snapshot decoding. Efficient bulk map construction and long-session performance are also unfinished. Values supplied to `set` must already be durable and must be verified through the content provider when loaded.
