# Scoped viewing credentials

The server API can issue expiring, read-only credentials for a single recording revision. Owners and that recording's publisher credential can manage grants. Viewers cannot manage grants, publish events, upload attachments, change visibility, or build server snapshots.

| Operation          | Endpoint                                             | Body                                                     |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| Issue              | `POST /api/v1/streams/:id/viewing-grants`            | `{ "label": "Demo viewer", "expiresAt": 1790000000000 }` |
| List active grants | `GET /api/v1/streams/:id/viewing-grants`             | None                                                     |
| Revoke             | `DELETE /api/v1/streams/:id/viewing-grants/:grantId` | None                                                     |

Use the owner or publisher bearer credential for these management requests. `expiresAt` is an absolute Unix timestamp in milliseconds, strictly in the future and at most 366 days away; replace the example timestamp with the intended expiry. Labels are limited to 200 characters. Issuance returns HTTP 201 with the grant metadata and a random `token`. The token is returned once; list responses exclude tokens and hashes. Revoke returns `{ "revoked": true }`, or false if the grant does not exist for that recording. The API responses use the server's no-store policy.

Use the issued token as the bearer credential for recording metadata, history, attachments, exports, snapshot reads and viewer tickets. The existing web viewer's credential input can use it. A watch ticket retains the grant's authorization requirement: revoking the grant before subscription prevents private access. Existing grant-backed WebSockets close with code 1008 when the grant is revoked or expires. When the grant's authorization ends, active HTTP responses it authorized (history pages, attachment downloads, exports, snapshot reads) are cancelled and their connections are closed before completion. The client sees a failed or truncated transfer, never a complete one. Other grants, owner, device and publisher readers of the same recording continue unaffected. Bytes already delivered to a client cannot be withdrawn. Account-session, device and publisher-credential revocation, restriction to private and removal cancel the transfers they authorized in the same way; see [in-flight HTTP transfer revocation](hosted-identity.md#in-flight-http-transfer-revocation). A failed durable revocation does not report success or invalidate currently authorized readers.

Grants are stored as hashes in `server/viewing-grants.json` with owner-only permissions and a process lock. Grant storage is bounded to 10,000 active records globally, 128 per recording and 4 MiB serialized data, with bounded write admission and active authorization registrations. Expired grants are reclaimed on issuance. Backup includes the ledger; restored recordings receive new revisions, so old grants cannot authorize them. List can still show an unexpired grant for an old revision until an administrator revokes it.

Public/unlisted recordings remain readable without credentials according to their visibility. Revoking a grant does not make a public recording private. Authorization scope applies to grant-based access; it is not a substitute for recording visibility.

Server API, CLI and browser sharing management are implemented and tested. Broader live transfer/expiry/fault acceptance, hosted identities/accounts remain unfinished. Publisher rotation/revocation is described in [publisher credential management](publisher-credentials.md). The current checks cover scope and privilege restrictions, restart persistence, successful revocation closing subscriptions, denial of unused revoked tickets, timed expiry, and response-source cancellation. The production gate remains open.

## CLI management

```sh
agentlive viewing-grant --server https://recordings.example.com --stream RECORDING_ID --label "Review" --expires-at 2026-10-01T12:00:00Z
agentlive viewing-grants --server https://recordings.example.com --stream RECORDING_ID
agentlive revoke-viewing-grant --server https://recordings.example.com --stream RECORDING_ID --grant-id GRANT_ID
```

Management uses the existing `--owner-file` or `AGENTLIVE_OWNER_SECRET` credential mechanism. The recording's publisher credential can also manage its grants. Choose an expiry in the next 366 days; an explicit timezone is required. Issuance writes JSON containing the token to stdout once, so capture that output in a private file if it should not appear in terminal scrollback:

```sh
(umask 077; agentlive viewing-grant --stream RECORDING_ID --label "Review" --expires-at 2026-10-01T12:00:00Z > viewer-grant.json)
```

Use the issued JSON directly with CLI read commands:

```sh
agentlive watch --server https://recordings.example.com --stream RECORDING_ID --viewer-file viewer-grant.json
agentlive replay --server https://recordings.example.com --stream RECORDING_ID --viewer-file viewer-grant.json
agentlive export --server https://recordings.example.com --stream RECORDING_ID --viewer-file viewer-grant.json --output recording.agentlive
```

`--viewer-file` accepts the private JSON produced by `viewing-grant`. It verifies the token format, recording ID and expiry, rejects symlinks/nonregular files and files over 4 KiB, and requires owner-only permissions (`chmod 600 viewer-grant.json`). An explicit viewer file takes precedence over `AGENTLIVE_OWNER_SECRET`; failed or revoked viewer access never falls back to that owner credential. It cannot be combined with `--owner-file`, `--anonymous` or offline `--source`, and management/publishing commands reject it. The file does not bind a server origin: use the trusted server from which the credential was issued.

For the browser, enter the JSON's `token` in the access-key input. The issued JSON is grant metadata, not an owner credential file. The legacy `AGENTLIVE_OWNER_SECRET` mechanism also continues to accept a viewer token for read commands; server authorization still limits it to scoped reads.

Issuance is deliberately not retried automatically. If a response is lost, list grants and revoke the newly created grant whose token you did not receive, then issue another. Listing never returns a token. Repeating revocation is safe and reports false once the grant is absent. The installed-package probe exercises issuance/list/revocation, and a CLI integration test verifies private replay followed by revocation denial.

## Browser sharing

Join the recording with its owner or publisher access key, then open **Manage viewing access**. Choose a label and an expiry of 1–366 days, and select **Create viewing credential**. Send the displayed recording link and credential privately to the viewer. The link contains only the recording ID; the credential is masked and has a copy button. If clipboard access is unavailable, select and copy the credential field manually.

The issued token exists only in the open panel's memory. **Hide credential**, closing the panel or leaving the recording clears it; refreshing the list does not retrieve it. Reopening the panel lists grant labels and expiry dates with **Revoke** controls. A viewer credential can join the recording but cannot administer its grants. If a creation request has an uncertain outcome, refresh and revoke the unwanted grant before creating another.

The real Chrome probe (`node scripts/probe-sharing.mjs`) verifies issuance, private reads and privilege denial, missing-clipboard feedback, token clearing on close/reopen, browser revocation and mobile layout/accessibility. See [the aggregate report](browser/sharing-2026-09-10.json). This does not establish cross-browser, physical-device or complete assistive-technology acceptance.
