# Abuse reports

The server has durable report intake and operator-only listing. Browser submission is available through **Report recording** in the viewer. Operator decisions and report-driven removal are available through HTTP. CLI and browser operator controls are available.

The browser asks for a category and explanation, explains what is saved, and displays a report reference after acknowledgement. An uncertain response keeps the same payload and operation ID for **Retry report**. Leaving the recording or reloading discards this in-memory retry state; a new submission afterward may create another report.

`POST /api/v1/streams/:id/reports` accepts:

```json
{
  "operationId": "UNIQUE_RETRY_ID",
  "category": "privacy",
  "details": "Explain the concern without including credentials."
}
```

Categories are `privacy`, `harmful`, `spam`, and `other`. Details must contain 1–1,000 characters after trimming. The caller must have viewing access: anonymous callers can report public/unlisted recordings, while private recordings require an authorized credential or owner account. Browser account mutations use existing Origin/CSRF checks. Reports do not grant access or change recording visibility.

Successful responses contain only `reportId` and `receivedAt`. A retry with the same operation ID, recording revision, reporter identity and payload returns the original receipt; reusing the operation ID differently fails. A removed recording cannot accept further submissions through this endpoint, including retries; operator listing retains reports already saved.

`GET /api/v1/reports?limit=50&after=REPORT_ID` requires the server operator bearer credential. Recording owners, viewers and publishers receive no report-listing authority. Pages contain reports with category/details, recording ID/revision, timestamps and optional reporter account ID. Clients must treat report text as untrusted content. This implementation does not copy event bodies, attachments or credentials into a report automatically, nor send reports to an external service.

The ledger is a private server file under the exclusive server lock. Writes commit before acknowledgement; uncertain storage failures require reopening. Input and persisted reads are bounded. Current intake limits are 32 new reports per minute globally, 32 queued operations, and 1,000 retained reports. Existing identical retries do not consume new-report capacity. The minute limit resets on restart. At capacity the server returns `retry_later`; report archival, per-reporter limits and operational capacity management remain unfinished.

Focused HTTP tests cover viewing authorization, operator-only listing, pagination, receipt retry, conflicting retry, restart, private file permissions, input limits and intake limits. Full abuse resistance, retention, operator controls, broader browser lifecycle acceptance and production verification remain open.

## Browser operator review

Enter the server operator credential in **Access key**, then open **Review reports (operator)**. The panel shows one page at a time, with **Refresh reports** returning to the first page and **Next report page** advancing. Ordinary account sign-in does not grant operator access.

Review the recording ID/revision and the report explanation, choose dismissal or removal, and supply a review note. Removal requires a checked confirmation. Saved decisions cannot be edited; pending removals show **Retry report decision** with the saved action/note and require removal confirmation again when loaded. Report explanations are displayed as text. Changing the access key resets the panel and aborts its active requests.

A timed-out decision may already have been saved. Retry it or refresh to inspect server state. Unsaved browser retry state is discarded when the panel closes or changes page. The server still rejects a conflicting decision if the first request committed.

## Operator CLI

Use an operator owner file or `AGENTLIVE_OWNER_SECRET`:

```sh
agentlive reports --server https://agentlive.example --owner-file owner.json --limit 50
agentlive reports --server https://agentlive.example --owner-file owner.json --after LAST_REPORT_ID
agentlive review-report --server https://agentlive.example --owner-file owner.json \
  --report-id REPORT_ID --revision REPORTED_REVISION \
  --operation-id REVIEW_OPERATION_ID --action dismiss --note "Reviewed; no removal needed"
agentlive review-report --server https://agentlive.example --owner-file owner.json \
  --report-id REPORT_ID --revision REPORTED_REVISION \
  --operation-id REVIEW_OPERATION_ID --action remove --note "Reason for removal" \
  --confirm-removal
```

Choose one decision per report. The examples show alternative actions, not a sequence. Commands output JSON; treat report explanations as untrusted text. Retain the decision arguments and repeat them unchanged after uncertain outcomes. `reports` includes the saved decision for pending `removing` records. These operator commands reject `--account-file`; ordinary account ownership does not grant report administration.

## Operator decisions

Send `POST /api/v1/reports/:id/decision` using the operator bearer credential:

```json
{
  "operationId": "UNIQUE_REVIEW_OPERATION",
  "action": "remove",
  "revision": "REPORTED_RECORDING_REVISION",
  "note": "Reason for the operator decision"
}
```

Actions are `dismiss` and `remove`. The trimmed note must contain 1–500 characters. Use `reviewRevision` when present; otherwise use `revision` from the report being reviewed. A different revision, or a different decision after one has been recorded, is rejected. Successful responses contain the updated report. Identical retries return its original resolved timestamp.

Dismissal records the decision without changing the recording. Removal durably records status `removing` and the decision before calling recording removal, then records status `removed` after confirmation. If interruption occurs between these writes, operator listing continues to show `removing`. Repeat the exact saved decision to finish; restart does not automatically execute pending decisions. Failures before or after the removal side effect are retryable this way. A failed ledger write requires reopening before retry, since replacement durability can be uncertain.

The report's revision also protects recordings restored under a new revision. An old pending decision cannot silently remove that restored recording. Restore reconciliation preserves original report evidence and requires the operator to review the current recording and its restore history. Report decisions do not imply physical cleanup of backups or client copies.

HTTP tests cover operator-only decisions, revision mismatch, dismissal, conflicting retries, and restart retries with injected interruptions before/after recording removal. Actual process-death and storage-failure review acceptance remains open.

## Reports after restore

Restore reconciles unresolved (`open` or `removing`) reports before clearing the destination's restore marker. The original `revision` and report explanation remain unchanged. `reviewRevision` identifies the restored recording to review. A `reconciliations` history records the previous/new revisions, restore time, and any previous decision. Pending decisions become historical evidence and the report returns to `open`; it does not automatically remove the restored recording.

Operators must use a new operation ID and the current `reviewRevision`. Old-revision decisions and reuse of a historical decision's operation ID are rejected. The browser shows the restored revision and prior decision notes and starts a fresh form. CLI operators should copy `reviewRevision` from `reports` into `review-report --revision`. Dismissed and completed removal reports remain resolved; tombstones retain their existing revision and pending tombstone removals remain retryable.

Restore history is bounded to 32 reconciliations per report, within the 8 MiB ledger limit. If reconciliation cannot preserve the evidence within these limits, restore fails before the destination becomes usable. It does not silently discard history. The current retention/archive workflow does not yet provide a way to compact this history.

A real backup/restore integration verifies retained evidence, stale-decision rejection, historical operation-ID rejection, and successful fresh review/removal. The browser fixture separately verifies displaying and reviewing a reconciled report. This does not reconcile removals that occurred after the backup was taken; those still need to be reapplied before the restored service is exposed.
