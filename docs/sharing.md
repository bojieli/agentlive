# Sharing and moving recordings

Recordings start private. This page covers making one readable by others, exporting it as a portable file, and moving it to a different server.

For revocable per-recording credentials see [viewing credentials](viewing-credentials.md); for hosted accounts see [hosted identity](hosted-identity.md).

## Who can see a recording

Every recording is created private: reading it needs a credential. Three visibilities exist — `private`, `unlisted` (readable by anyone with the recording ID, not listed) and `public` (readable and listed).

Choose one when the recording is created (`import`/`publish --visibility public`), or change it later:

```sh
agentlive visibility --stream <recording-id>                          # what is it now?
agentlive visibility --stream <recording-id> --visibility public      # change it
```

The change is made against the version just read, so a concurrent change is rejected rather than overwritten, and repeating the command is a no-op rather than a second change. Making a recording private again immediately cuts off anonymous readers, including downloads already in flight.

To let one person watch a private recording without giving them the owner credential, issue a scoped credential instead — it is limited to that recording, expires, and can be revoked:

```sh
agentlive viewing-grant --stream <id> --expires-at 2027-01-01T00:00:00Z
agentlive viewing-grants --stream <id>
agentlive revoke-viewing-grant --stream <id> --grant-id <grant>
```

Revoking one takes effect immediately, including for transfers and sockets already running. See [viewing credentials](viewing-credentials.md) for the file format and the exact guarantees.

**Before sharing anything, look at the recording as a viewer.** Known secrets are filtered from message text and from captured file bytes, but filtering is exact-substring: an encoded or reformatted copy of a secret survives, and only the artifact roots you allowed were ever read. Once an archive is downloaded or a recording has been public, you cannot recall it.

## Portable recordings

Export a frozen recording prefix, replay it offline, or import it into another server:

```sh
agentlive export --stream <recording-id> --output session.agentlive --server http://127.0.0.1:7331
agentlive replay --source session.agentlive
agentlive replay --source session.agentlive --from-ms 30000 --speed 4
agentlive import --source session.agentlive --server http://127.0.0.1:7331
```

Use the usual owner credential file or `AGENTLIVE_OWNER_SECRET` for private export and server import. Public/unlisted exports also support `--anonymous`. Export refuses to replace an existing output file. Offline replay needs no server or credential and supports the existing terminal playback controls.

The `.agentlive` file is a ZIP containing a versioned `manifest.json`, the filtered `events.jsonl` prefix, and every published attachment version referenced by that prefix under `attachments/<sha256>`. Pending/unavailable attachments remain pending/unavailable. An active recording can continue while its captured prefix is exported. Imports receive a new identity/revision, start private, and are ended; a live-prefix import adds a final server lifecycle event without changing its captured observations. Native-history import remains `import --agent <agent> --source <native-file>`.

The manifest records the source recording boundary, known agent/provenance, format versions and file hashes. Unknown source/adapter versions are represented explicitly as null. Server owner/publisher credentials and unpublished spool data are excluded. Default offline playback treats embedded content as data; attachment output identifies the corresponding ZIP entry. Derived snapshots are omitted from the initial portable format and regenerated during playback. This version accepts event and attachment entries, not optional snapshot/content entries from future format revisions.

Current archive limits are 8 GiB of expanded event/attachment data, 16 MiB of manifest data, 100,000 listed files, 1 MiB per event line and 64 MiB per attachment. ZIP entries with unsupported paths, duplicates, symlinks, executable permissions, encryption, incompatible versions or mismatched hashes/sizes are rejected. The server admits up to two concurrent imports and two concurrent exports. These are implementation limits, not measured large-archive throughput claims.

## Moving a recording to another server

`migrate-recording` transfers an ended recording that a local binding published to a different server using only its committed history, so the native transcript is not needed:

```sh
agentlive finish --stream <recording-id>
agentlive migrate-recording --source <binding-directory> --operation-id <unique-id> \
  --target-server https://new.example.com --target-owner-file <destination-owner.json> \
  --old-recording retain            # or: remove --confirm-removal
```

`status` shows the binding directory. The command requires every captured event to be delivered and the source recording to be ended at the binding's boundary. It persists an intent, exports a staged `.agentlive` archive into the binding directory, verifies the archive against the source boundary, and imports it into the destination as a private ended recording whose metadata records the source server, recording, revision and boundary (`archiveOrigin`). Only then does it apply the requested disposition to the source. Rerunning with the same operation ID after an interruption or a lost response reuses the staged archive and destination recording; a different destination or operation for the same binding is rejected. The destination recording is continued like any archive import (a new identity); the old binding is marked transferred and cannot publish again, and `retire` can set it aside. To re-convert history under a changed converter or filter policy instead, see [converter migrations](converter-migrations.md).
