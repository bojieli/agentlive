# Browser snapshot range cache

`BrowserSnapshotCache` implements the optional `SnapshotReadCache` interface consumed by `RecordingSnapshotClient`. The shared client creates keys from its normalized server/recording base URL, recording revision, full content reference, offset and length. Credentials are not stored. Snapshot selection/publication still goes to the server before opening a reader, even when all requested content is cached.

Each stored range contains at most 65,536 UTF-16 units and a key of at most 2,048 units. A shared IndexedDB database retains at most 256 rows, evicting by oldest write time. Thus retained text is at most 16,777,216 UTF-16 units, plus keys/checksums/database overhead; overlapping ranges count separately. This is a bounded acceleration cache, not a guarantee of complete offline snapshot retention. Large recordings may evict earlier ranges and fetch them again.

Checksums cover canonical JSON containing the key and text, preserving lone surrogates and binding cached bytes to the requested range. Reads verify the checksum before exposure. Invalid rows are cache misses and can be replaced by an authoritative network response. These checks detect local corruption; HTTP content verification still relies on the existing authenticated server transport, not independent range proofs.

Crypto executes outside IndexedDB transactions. Writes and eviction share one transaction, including across tabs. There are at most 16 admitted operations per cache instance, each with a 10-second deadline. Version changes and close abort active work and close the database. Late successful database opens after cancellation are immediately closed. The shared client independently bounds cache waits and observes late completion/rejection without waiting indefinitely for a supplied cache implementation. Cache errors disable that client's cache and fall back to the network; caller cancellation still propagates.

The browser's clear-saved-history action also clears snapshot ranges. The cache is exercised with fake IndexedDB and real native-session HTTP snapshot reconstruction, including closing/reopening the database. Actual browser quota/eviction/device validation remains required.

This implements persistence for read-only snapshot ranges. BrowserSession still reconstructs its event history and working state in memory. Automatic snapshot seeking, locally generated paged state, durable root publication and complete offline replay remain separate integration work.
