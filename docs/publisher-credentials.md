# Publisher credential management

Each recording has a reusable publishing credential distinct from its viewing grants. Owners can inspect, rotate or revoke it. The server stores its hash and a versioned operation record; raw replacements remain only in the publisher's protected local binding. Rotation and revocation invalidate the active publishing lease after the metadata change commits. Old credentials cannot resume, upload/install attachments or finish/reopen a recording. In-flight attachment uploads and private reads authorized by the old credential are aborted after the change commits ([details](hosted-identity.md#in-flight-http-transfer-revocation)). Already committed events remain available according to viewing permissions.

## Rotate a publisher binding

Stop the publisher using the binding, then run:

```sh
agentlive rotate-publisher-credential --source /path/to/publisher/HASHED_BINDING_DIRECTORY --owner-file /private/owner.json
```

The command takes the existing journal's exclusive lock and uses its recorded server origin, stream, revision and publisher identity. It generates and durably saves a replacement and operation ID before contacting the server to install them. The old local credential remains until the server confirms the versioned operation. The command then atomically promotes the replacement and clears the pending operation. It never prints either credential. Start the normal publisher again afterward; event sequence, epoch, source mapping and acknowledged position are preserved.

If the request or response is interrupted, rerun the same command. It reuses the pending replacement and operation ID. Normal publishing refuses a binding with an unfinished rotation. If another administrator changed or revoked the credential in the meantime, the retry fails its version precondition rather than undoing that action. After inspecting the current state, an owner can explicitly start a fresh rotation with `--restart-rotation`. This replaces the pending attempt with a new durable replacement against the current version. A changed recording revision requires separate recovery; the rotation command does not silently migrate revisions.

`AGENTLIVE_OWNER_SECRET` can supply the owner credential instead of `--owner-file`. The publisher key itself cannot authorize rotation or revocation.

## Inspect and revoke

```sh
agentlive publisher-credential --server https://recordings.example.com --stream RECORDING_ID
```

The JSON response includes `revision`, `version`, `revoked`, and recording/publisher identifiers, with no credential or hash. Copy the returned revision and version into the revocation command and choose a unique operation ID:

```sh
agentlive revoke-publisher-credential --server https://recordings.example.com --stream RECORDING_ID --revision REVISION --expected-version 0 --operation-id revoke-2026-09-10
```

The explicit revision/version prevents an old command from revoking a later replacement. Retry an uncertain request with exactly the same arguments. Reusing an operation ID with different content fails. Once a newer credential operation commits, older requests fail their preconditions. An owner can restore publishing access by rotating the stopped publisher binding to a fresh key. Revocation does not end the recording or revoke independently issued viewing grants.

## API and acceptance

Owner bearer authorization is required for both endpoints:

- `GET /api/v1/streams/:id/publisher-credential` returns the current state.
- `POST /api/v1/streams/:id/publisher-credential` accepts `{ operationId, revision, expectedVersion, replacementSecret }`. Supply a random 64-character lowercase hexadecimal replacement to rotate, or `null` to revoke. Persist replacements privately before making the request.

Mutations share the recording's serialized writer. Metadata replacement persists credential state and an advanced lease generation together. Failed persistence does not report success; a failed write before replacement leaves the existing in-memory credential and lease active. Queued resume, attachment status and lifecycle operations recheck credentials when they execute. Existing publisher connections lose their valid lease and cannot append further events; immediate socket closure is not required for that fencing.

Focused integration tests cover owner-only access, lease fencing, queued resume, restart, stale/idempotent requests, failed-save behavior, lost-response recovery through the actual CLI, subsequent publishing and explicit restart after an intervening revocation. Installed-package checks cover inspection and repeatable revocation, including backup/restore of the resulting state. Actual process death at every filesystem boundary, broader concurrent administration/transfer acceptance and hosted account authorization remain production-gate work.
