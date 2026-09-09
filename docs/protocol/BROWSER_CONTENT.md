# Writable browser content

`BrowserContentStore` supplies the put/append/read interface used by PagedReducer. Its immutable pages and manifests use the same portable `TextContent` codec as the filesystem TextStore. Equal strings and append results produce identical content references across both backends, including lone UTF-16 surrogates and page boundaries. The codec lives in the protocol package and has no filesystem dependency; each backend retains its own admission, persistence and verification behavior.

The IndexedDB backend namespaces blobs by a hash of normalized server origin, stream ID and revision. Credentials are not persisted. It verifies byte length and SHA-256 before decoding stored JSON. Reusing an existing blob compares its bytes exactly; corrupt existing content is rejected rather than silently overwritten. Root publication and recovery from browser eviction remain caller responsibilities.

## Transactions and limits

Crypto executes outside IndexedDB transactions. Blob insertion and shared quota accounting commit together, so concurrent handles cannot admit overlapping reservations beyond the configured limit. Default accounted blob capacity is 512 MiB across all recordings in the database; callers may set a lower admission ceiling. Database/key overhead is additional. Content is not automatically pruned or evicted by this implementation, and unfinished writes can leave unreferenced immutable blobs.

The shared codec uses 16,384-unit text pages, up to 4,096 pages per text, 1 MiB per encoded blob and reads of at most 65,536 UTF-16 units. Per store, at most 16 operations are admitted and serialized. Each browser operation has a 10-second deadline, including queue time. Close stops admission, cancels source ingestion and drains accepted transactions before closing the connection. Version changes close affected handles; clearing saved browser history also deletes this database. Deletion can finish after a caller stops waiting, as with IndexedDB history deletion.

IndexedDB is an evictable browser cache, not the authoritative event log or a guarantee against device power loss. The browser must revalidate recording access on join and reconstruct from server history/snapshots after losing local content. No publication cursor may claim a root solely because a partial page write completed.

## Verification and remaining integration

Tests compare filesystem and IndexedDB references after Unicode append and reopening, restore a pending replacement checkpoint and continue reduction, enforce quota across simultaneous handles, close stalled input, reject corrupt bytes and clear open handles. Native verification applies actual captured events through both backends, requires equal midpoint checkpoint references, reopens both stores and compares final state to reference replay. Test IndexedDB is fake-indexeddb; actual browser quota, crash, eviction and device behavior remain acceptance work.

This is the writable content backend. BrowserSession still needs paged working-state publication, history ranges and asynchronous viewport queries. The existing range cache serves read-only server snapshot ranges; it does not automatically import entire immutable blobs into this store. That transport/local-content bridge and safe root retention are still required for snapshot-plus-suffix reconstruction in the browser.
