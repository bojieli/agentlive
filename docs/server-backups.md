# Operational server backups

`agentlive backup --state-dir <state> --output <new-directory>` creates a checksummed offline copy of server state and the persisted owner credential. `--owner-file` selects a non-default credential path. Stop the server first; the command refuses a data directory owned by a running server and suggests the online form below. Output must be a new directory outside the server data tree, with an existing parent directory. To back up without stopping the server, see [Online backup of a running server](#online-backup-of-a-running-server).

```sh
agentlive backup --state-dir "$HOME/.agentlive" --output /backups/agentlive-2026-09-10
```

The output contains `owner.json`, `server/`, and a versioned `backup.json` manifest listing each non-lock file's path, size and SHA-256. The manifest is written last and marks completion. A process crash can leave an incomplete output directory; a directory without its completed manifest is not a backup. The command refuses to replace any existing directory. Source files remain unchanged; normal server recovery validates event checksums and referenced attachment bytes on the copy before publication. Recovery may remove an incomplete trailing log record from the copy, preserving the last valid committed prefix.

Credentials and directories receive owner-only permissions. This is an operational backup containing private credentials, metadata and recording contents, unlike a portable `.agentlive` export. Environment-only owner credentials are not included: the command requires a persisted owner file and refuses `AGENTLIVE_OWNER_SECRET` to avoid suggesting those credentials were captured. Publisher spools, native transcripts and viewer caches are excluded. Lock inodes are not part of the manifest. Symlinks and special files are rejected. The initial implementation bounds source data to 100 GiB, 100,000 entries and directory depth 32, using streamed copies/hashes and cancellation checks.

## Online backup of a running server

```sh
agentlive backup --server http://127.0.0.1:7331 --output /backups/agentlive-2026-09-11
```

With `--server`, the running server process writes the backup itself, in exactly the offline format (`owner.json`, `server/`, completed `backup.json`), so `agentlive restore` accepts it unchanged. The command authenticates with the operator owner credential (`--owner-file`, the default state-directory owner file, or `AGENTLIVE_OWNER_SECRET`). `--output` is resolved to an absolute path by the CLI but is created **on the server host's filesystem** by the server process; it must be a new directory whose parent already exists there, outside the server data directory, and writable by the server's user. This is an operator feature intended for a local or same-host server; for a remote server, the backup lands on that remote host, not beside the CLI.

The HTTP interface is `POST /api/v1/admin/backup` with `Authorization: Bearer <owner-credential>` and a JSON body `{"output": "/absolute/server-host/path", "barrierTimeoutMs": 30000}` (`barrierTimeoutMs` is optional, 1000–600000). Only the operator owner credential is accepted: anonymous callers, publisher write credentials, viewing grants and hosted account browser/device sessions receive 401/403. Authorization, request and destination errors (relative, nested, existing or parentless output) are ordinary JSON errors returned before any work starts. Once accepted, the response is NDJSON: `started`, `progress` (`attachments`, `barrier`, `verifying`) and periodic `heartbeat` lines, then exactly one final `{"event":"backup",...}` result (including `barrierMs`) or `{"event":"error","code",...}` line. Only one backup runs at a time; a concurrent request receives a retryable `retry_later` (HTTP 503).

The backup runs in three phases:

1. **Attachment pre-copy (writers keep running).** Content-addressed attachment files are copied and each copy's SHA-256 is checked against its name. These files are immutable once installed, so this large, slow part of the copy does not pause writers.
2. **Write barrier.** The server stops admitting durable mutations and waits for already admitted ones to finish: recording creation, archive import and removal; publisher resume, event appends, lifecycle end/reopen, attachment installation and collection; visibility, publisher-credential and migration-origin changes; and report, viewing-grant, account and account-session ledger writes. Mutations arriving meanwhile wait (they are not rejected) and proceed in arrival order after release. With no mutation in progress, the remaining authoritative files — metadata, event logs, the creation index, ledgers and attachments added since phase 1 — are copied; pre-copied attachments that no longer exist are dropped. The barrier is then released.
3. **Verification (writers running again).** The copy, not the live data, is opened and recovered like the offline backup (event hash chains and every referenced attachment are validated), inventoried and hashed, and the manifest is written last.

What is consistent: every authoritative file in the backup reflects one instant at which no durable mutation was in progress, so a restored recording is an exact byte prefix of the live event log with every referenced attachment present, and ledgers never reference state newer than the recordings. Reads, HTTP history, attachment downloads, live subscriptions and viewer snapshot reads continue during the barrier.

What is not included or not paused: derivative snapshots and snapshot leases (restore removes them anyway) and in-flight upload staging (discarded on reopen) are skipped, so snapshot building, lease renewal and upload body streaming keep running; an upload only waits for its final installation step. The online backup always records the running server's owner credential as `owner.json`, whatever its source (including an environment-provided secret).

Limits and failure behaviour: the barrier lasts from the moment admission stops until the barrier-phase copy finishes, so its duration grows with event-log and metadata size (not with previously installed attachments). It is bounded by `--barrier-timeout-ms` (default 30000): if draining or copying exceeds it, the backup fails with `retry_later`, the partial output directory is deleted and writes resume. Any failure, operator disconnect (Ctrl+C or a dropped connection) or server shutdown also cancels the backup, deletes the partial output and always releases the barrier; shutdown does not wait for a backup to finish. While paused, publishers and HTTP clients see increased latency; a publisher that pipelines more than its per-socket message allowance, or times out, reconnects and resumes normally. A concurrent file change the barrier does not cover (for example, crash-tail recovery when an uncached recording is first opened during the barrier) makes the copy fail with "Backup source changed while copying"; retry. The same 100 GiB / 100,000 entry / depth 32 limits apply. A backup process crash (as opposed to a reported failure) can leave an incomplete output directory without `backup.json`; as with offline backups it is not a backup and must be deleted manually.

Local integration checks run an online backup while a publisher appends events and attachments and viewing grants are issued, restore it, and verify the restored log is a byte prefix of the live log with every referenced attachment present; they also cover owner-only authorization, destination validation, busy rejection, mutations waiting on a pending barrier while reads continue, barrier-timeout failure with output cleanup and resumed writes, shutdown cancellation and the CLI. Hosted-mode account rejection is covered by the owner-only check rather than a dedicated hosted test. This is not production disaster-recovery acceptance.

## Restore into a new state directory

```sh
agentlive restore --source /backups/agentlive-2026-09-10 --output /srv/agentlive-restored
agentlive serve --state-dir /srv/agentlive-restored
```

The destination must not exist, and its parent must exist. Restore verifies the completed manifest, relative paths, exact file inventory, sizes and SHA-256 values before admitting the copied state. It refuses symlinks, special files, traversal, duplicate/missing/unlisted files and unsupported manifest versions. Hashes establish integrity against the supplied manifest, not the identity of the backup creator; restore only a backup whose origin you trust.

Every recording receives a fresh revision while preserving its stream ID, event bytes, attachment bytes and publisher identity. Old derivative snapshots and snapshot leases are removed. Event chains and referenced attachments are validated again before completion. `restore.json` records the old/new revision mapping without exposing credentials. The owner credential remains the backed-up credential. The command does not activate the restored server or overwrite a running deployment.

The destination server remains locked during restore. A `.restore-in-progress` marker also prevents normal startup after a process crash. An incomplete restore must be discarded and retried to another new directory; do not remove the marker manually. Ordinary reported failures clean up their own destination. Completed restore syncs data/directories before removing the marker. Source backup files remain unchanged.

Clients holding the old revision must revalidate: HTTP history requests receive a revision conflict and publisher resume with an old revision receives `revision_changed`. Publishers with their complete retained journal can use the explicit recovery command below. General converter/filter and import-origin binding migration remain unfinished. Do not manually rewrite saved cursors or binding files. A fresh viewer can read restored history using its existing access credential and the new revision.

For rollback, retain the stopped original data directory and its compatible image. Start that pair if the new deployment must be abandoned; recordings written only to the newer deployment are not automatically merged back. Restoring any backup copy should use this command so clients cannot confuse a rolled-back prefix with their old revision. Compatible recording-format upgrades and automated rollback orchestration remain unfinished.

Local integration checks cover backup/restore, credential and event preservation, corrupt events/attachments, traversal and symlink rejection, startup fencing, removal of old snapshots, and old publisher/HTTP revision rejection. The isolated installed-package probe also creates a backup and restores it, verifies every backup hash and the persisted fresh revisions. This does not establish process-death fault coverage, actual-host disaster recovery, or full production acceptance.

## Data format versions, upgrades and rollback

Every server data directory carries `server/format.json` (`{"format": "agentlive-server-data", "version": 1}`). The server writes it under its lock at startup; directories created before the marker existed are format 1 and are stamped on first start. A release refuses to start on a directory, and `restore` refuses a backup, whose format is newer than it supports, with an error naming both versions, before reading or rewriting any other state. So rolling back to an older binary cannot silently reinterpret data written by a newer one. Offline and online backups include the marker.

Format 1 is the only format so far. A future release that changes the on-disk layout will bump the version and migrate one explicit step at a time at startup. Before upgrading:

1. Take a backup (`backup --server` while running, or offline) and keep the current image or package.
2. Upgrade and start the new release; check `agentlive doctor` and `/readyz`.
3. To roll back after a format change, stop the new release and `restore` the pre-upgrade backup into a new directory with the old release. Recordings written only after the upgrade are not merged back; clients revalidate against the restored revisions as described above.

Releases built before the marker existed do not check it; do not start them on data touched by a newer release.

## Recover an existing publisher after restore

Stop the publisher process, start the restored server at its original origin, then run on the publisher machine:

```sh
agentlive recover-publisher --source /path/to/publisher/binding-directory
```

The source is the specific hashed directory containing `binding.json` and `capture.jsonl`, normally under the publisher's AgentLive state directory at `publisher/<hash>`. Use the existing directory for that native session; no new binding is created. Recovery takes the publisher lock and uses its stored write credential. It requires a changed server revision, matching stream/publisher/epoch identity, and an exact event-by-event match between the restored server's entire publisher prefix and the retained local journal. Divergent or missing local history is rejected.

Immutable attachment bytes referenced by the lost suffix are re-uploaded from `artifacts/capture` before binding changes commit. Missing/corrupt required bytes leave the original revision and acknowledgement unchanged. Verified uploads may remain remotely after a failed attempt and are safe to retry. Server identity and the captured history boundary are rechecked before committing. Stop other writers during this administrative operation.

Successful recovery atomically changes the revision and resets the acknowledged producer sequence to the verified restored prefix. Capture state, source mappings, policy/converter identities and unacknowledged events remain intact. Restart the original publish command with its original options to deliver the suffix and continue capture. The recovery command itself does not run the native agent or publish events. It reports pending event and attachment counts without credentials. A second attempt after success reports that the revision is unchanged; use normal publisher resume.

An ended recording remains ended and needs the existing explicit reopening workflow. Changed server origins, publisher epoch handoff, import-origin converter/filter upgrades, pruned journals and incomplete artifact spools are not automatically migrated by this command. The local recovery test publishes beyond a backup, restores the older prefix, recovers through the CLI and verifies exact suffix redelivery with its attachment; full multi-adapter/crash/deployment acceptance remains open.
