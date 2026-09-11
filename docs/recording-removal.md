# Recording removal

The server implements durable removal from service. Removed recordings cannot be opened, published to, listed, or recreated by retrying their original creation request. Removal applies to live and ended recordings. It is irreversible through the API.

Removal deletes recording data after active session users drain. The server retains metadata as a tombstone to prevent old publishing retries from recreating the recording. Cleanup errors are retried by a removal retry or server restart; acknowledgement establishes removal from service, not completion of all physical cleanup. Existing backups, exports and downloaded or cached copies are outside this cleanup's scope.

## Browser and CLI

Open **Manage viewing access** while viewing a recording you own. The removal section appears after owner authorization succeeds. Check the explicit confirmation, then choose **Remove recording**. If the response is uncertain, **Retry recording removal** repeats the same operation. Successful removal ends remote access; cached playback and exports may still exist.

The CLI requires an explicit revision and operation ID, which you should retain for retries:

```sh
agentlive remove --server https://agentlive.example \
  --account-file account.json --stream RECORDING_ID \
  --revision RECORDING_REVISION --operation-id UNIQUE_OPERATION_ID \
  --confirm-removal
```

Use `agentlive list` to obtain the current recording ID and revision. Standalone operators can use their existing owner credential instead of `--account-file`. The command prints the removal receipt as JSON. Repeating the command returns the original removal time. Recording data cleanup follows the lifetime rules above.

## HTTP operation

Send `POST /api/v1/recordings/:id/removal` with JSON:

```json
{
  "revision": "CURRENT_RECORDING_REVISION",
  "operationId": "UNIQUE_OPERATION_ID"
}
```

The recording's owning account (browser session or device credential), or the standalone operator credential, may remove it. Browser mutations require the same Origin and CSRF protection as other account operations. Publisher and viewing credentials cannot remove recordings.

Successful responses contain `streamId`, `removed: true`, and `removedAt` as Unix milliseconds. The revision precondition prevents removing a restored recording using stale state. Repeat requests return the original removal time; another removal operation ID cannot make the recording available again. Keep the original request for retries after uncertain network outcomes. The endpoint is separate from stream-reading routes so it remains usable after removal.

Removed stream requests return the existing `stream_gone` protocol error (HTTP 404). Durable creation metadata remains to fence old publisher creation retries. Removal cancels registered recording HTTP response lifetimes for all credential types, invalidates subscriptions, rejects queued session work and unregisters automatic snapshots. Bytes already transferred cannot be withdrawn. Work preparing a response may continue until it reaches a cancellation check; the response middleware rejects it before returning a new body after removal.

## Verification and remaining work

Focused tests exercise store restart, repeat removal, stale creation retries, owner denial, revision mismatch, persistence failure before commit, listing pagination, subscriber fencing and response cancellation. HTTP tests exercise operator removal and publisher/anonymous denial; hosted account tests exercise ownership, CSRF and invalid-bearer precedence.

Cleanup is tested with held session references, an interrupted-cleanup fixture, and backup/restore round trips. Restored tombstones preserve their revision and removal receipt; active recordings still receive new revisions. A backup created before removal can restore the recording: operators must reapply subsequent removals before making that restored server available. Removal does not rewrite older backups.

Fault injection covers metadata failures before and after replacement. Access stops on an uncertain persistence result until session/store reopen resolves the on-disk state. Actual process-death, filesystem fault and network transfer race acceptance remains required. These tests do not establish completion of the production gate.
