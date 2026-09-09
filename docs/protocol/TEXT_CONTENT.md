# Immutable text content

TextStore persists text as fixed 16,384-UTF-16-unit pages plus a content-addressed manifest. JSON encoding preserves surrogate pairs and lone surrogate units exactly. Existing references remain readable when newer versions are written.

| Operation | Behavior |
| --- | --- |
| `put(source, signal?)` | Persist a complete string or async iterable of string chunks. |
| `append(base, source, signal?)` | Persist the base text followed by new chunks, reusing complete prefix pages. |
| `read(reference, offset, length, signal?)` | Verify and return a range of at most 65,536 UTF-16 units. |
| `close()` | Stop admission, cancel source ingestion, drain accepted work and release ownership. |

Append verifies the base manifest and all its page descriptors. It loads only a partial tail page when the source first supplies nonempty text. New text is combined with that tail into the same page boundaries used by put. Consequently, `append(put(prefix), suffix)` and `put(prefix + suffix)` produce identical references, including when chunks or pages divide a surrogate pair.

An empty append verifies the manifest and flushes the content directory, then returns the same reference without reading text pages or adding stored bytes. Append does not revalidate the bytes of every complete prefix page; corruption in an untouched page is detected when that page is read. A corrupt partial tail is rejected before extension.

Each async input chunk is limited to 65,536 units. A text has at most 4,096 pages (67,108,864 units); the manifest is bounded to 1 MiB encoded. Appending processes bounded chunks and at most one old text page, but still reads and rewrites the bounded page-descriptor manifest. A caller supplying a complete string already owns that string's memory; use a stream when bounded input memory matters. Do not have an input iterator await another operation on the same serialized TextStore; supply external chunks or read them before submitting the write.

Put and append share admission, quota, cancellation and durability handling. They return a reference only after observing successful final manifest installation and checking cancellation. A cancelled or failed operation may leave reusable orphan content. Retrying the same append against the same base yields the same reference and reuses existing bytes. Cancellation never removes or overwrites the base. Actual process-death tests cover interrupted page writes and completed manifests.

References are values, not mutable pointers. The caller must atomically publish the chosen new reference inside its recording/revision-bound state and retain old references needed for playback. Concurrent appends against one base create independent versions; TextStore does not choose a winning version. Snapshot/reducer integration, retention/pins and garbage collection are separate layers.


## Portable codec

TextStore now delegates page/manifest validation, streaming paging, append and bounded range reconstruction to the protocol package's TextContent codec. The filesystem backend retains its verified blob reads/writes, directory flushes, queue, close/drain and kernel ownership lock. BrowserContentStore uses the same codec with IndexedDB transactions; reference identity is tested across both backends. See [BROWSER_CONTENT.md](BROWSER_CONTENT.md) for browser capacity and eviction constraints.
