# Portable recording archives

Implemented archive version: `agentlive.recording` version 1, protocol/reducer version 1.

## User workflow

```sh
agentlive export --stream <id> --output session.agentlive --server http://localhost:7331
agentlive replay --source session.agentlive
agentlive replay --source session.agentlive --from-ms 10000 --speed 4
agentlive import --source session.agentlive --server http://localhost:7331
```

Private export and every import require the existing owner credential configuration. Export also accepts `--anonymous` for public/unlisted recordings. An export never overwrites an existing file. Archive replay makes no network requests and supports terminal pause, single-event stepping, speed and idle compression. Native-history imports continue to require `--agent`.

## Contents and semantics

- `manifest.json`: format versions, exported time, source recording identity/revision/title, frozen sequence/time boundary, lifecycle, known provenance/capabilities, gap count, optional completeness notice, and each file's size/SHA-256.
- `events.jsonl`: newline-terminated filtered StoredEvent records, preserving sequence, time, content and publisher provenance.
- `attachments/<sha256>`: exact bytes of every attachment made available in the prefix, including historical versions. Unavailable/pending attachments retain their event state and do not acquire replacement bytes.

`provenance.completenessNotice` is the effective `capture.completeness` notice at the frozen boundary: the latest notice after any `recording.reopened`, with its server sequence as `at`. It contains counts and a fixed reason only, in the payload version the recording carries: version 1 (messages, tools, withheld text) or version 2 (additionally running tasks, pending interactions and pending attachments; see [converter-migrations.md](converter-migrations.md#import-completeness-notices)). It is omitted when none applies. Readers recompute it from `events.jsonl` and reject a missing, extra or different value, including a notice whose version differs from the event's. Both payload versions are valid in archive version 1; the archive version is unchanged. Archives written before the field existed cannot contain the event, so they remain valid. Replay derives the notice from events regardless of the manifest.

No owner/write credential, unpublished spool, or server-private metadata file is copied. Unknown agent/source/adapter version information is recorded as null rather than inferred. Content that was already part of the authorized filtered recording remains recording data.

The writer captures metadata through the session's serialized publication queue, then reads only that prefix. Referenced attachment bytes remain retained by the live session's authoritative event references. Derived snapshots/content pages are optional and omitted by this initial implementation; version 1 accepts only event/attachment entries and reconstructs playback from events.

The importer validates into a private temporary directory and installs a new private recording with a new identity and revision. Publisher event stream IDs and their digests are rebound to the new identity; captured content, native source identity and timestamps remain. The original manifest is saved as `archive-provenance.json`. If the prefix was live, import adds a final server `recording.ended` event at the last recorded time. It does not stop or change the original recording. Imported recordings do not reuse source publisher credentials.

An imported recording is validated with the normal server recovery reader before its directory becomes discoverable. Incomplete staging directories remain hidden. Installation uses directory rename and directory synchronization; a post-rename storage failure is an uncertain result and requires reopening the store rather than guessing whether publication occurred.

## Limits and validation

Expanded events/attachments: 8 GiB total; manifest: 16 MiB; listed files: 100,000; event line: 1 MiB; attachment: 64 MiB. The upload/download envelope is capped at 9 GiB. The server admits two concurrent imports and two concurrent exports. Work streams data rather than retaining complete archives in memory; these limits are not benchmarked throughput promises.

Extraction accepts only the declared regular recording files, ZIP stored/deflate methods, and non-executable file permissions. It rejects path traversal, duplicate paths, symlinks, encrypted/unsupported entries, undeclared files, incompatible versions, expansion/size violations and hash mismatches. Manifest boundary, lifecycle, gap count, completeness notice, publisher content/digest identity and attachment references are checked. Hashes establish byte integrity, not publisher authenticity. Embedded attachment content remains inert data; terminal replay identifies its archive entry.

## Verification

- Real CLI subprocess flow: native import → export → offline replay → new server import → replay, with matching output.
- Real HTTP live-prefix/attachment round trip: new identity/revision, private visibility, ended import, original still live, exact attachment bytes.
- Format tests: event/attachment identity, no-overwrite publication, missing/changed bytes, inconsistent boundary, duplicate paths, executable/symlink entries, unexpected files, hash/version errors and path traversal.
- Isolated npm tarball verifier now exercises export, offline archive replay and portable import, alongside reproducible rebuild and the existing server/snapshot/retry checks.

Broader fault injection, archive migration/backup semantics, hosted account integration and release/platform acceptance remain part of the overall production gate. Optional snapshot acceleration and a browser file-open workflow are not implemented here.
