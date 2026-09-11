# Converter and import migration implementation audit

Status: inspection, frozen-import child-source relocation and replacement import with changed converter/filter/artifact settings are implemented. Frozen-import replacement can also target another server. Compatible in-place continuation, existing live-binding migration and archive-only server transfer remain unfinished. Existing mismatched-option checks remain in force. This audit identifies the state that a migration must handle before native converter behavior can change safely.

## Inspect an existing binding

```sh
agentlive inspect-migration --source /path/to/publisher-binding-directory
```

Stop any publisher holding that binding before inspection. The command takes the publisher lock, reads bounded private metadata and returns JSON with native/remote identity, acknowledged sequence, import/live policy version and fingerprint, complete manifest hashes, frozen source boundary and transition flags. It does not return write credentials, arbitrary manifest fields, titles or artifact paths. It does not open or recover the event journal or modify binding/import/live manifests. Acquiring and releasing the lock is its only temporary write.

The output explicitly reports `verification: "metadata-only"` and `migrationImplemented: false`. A valid result does not prove source availability, remote ownership, journal integrity, checkpoint compatibility or readiness to migrate. Malformed/symlinked metadata and concurrent ownership fail. Schema errors are sanitized instead of returning source values.

## Current durable identities

- `PublisherJournal.open` selects a directory by exact server origin, native agent and native session ID. Its binding carries publisher identity, epoch, creation request, write credential, remote recording/revision and acknowledged sequence. Selecting another root or origin creates another binding; it does not migrate the existing recording.
- `importNativeRecording` persists `import.json` containing converter version, artifact base/roots, filter fingerprint, source prefix hash/length, native identity, title, visibility and optional family sources. Import retries require exact identity equality. Live publisher or pending resume files reject import.
- `resumeImportedRecording` compares the import manifest with the live converter identity, checks the frozen source prefix, and prepares family state. `resume-import.json` persists the import/identity hashes, lifecycle preconditions and operation ID before reopening the remote recording. Known import/live family-version mappings are explicit compatibility cases, not a general upgrade mechanism.
- OpenCode import uses `OpenCodeCapture`, including persisted normalized object generations and pending revisions. Editing the older historical converter alone does not change the production OpenCode import path. Its current identity is `opencode-snapshot-4` (with separate family import identity).

## Required migration behavior

A migration must inventory and validate all of the above while owning the publisher lock. Its persisted intent must identify the source and target converter/filter policies, frozen native source boundary, source binding/revision, family scope and target action. Restart must resume that intent rather than create a second target or mix old and new policy output.

Compatible continuation requires evidence that replaying the captured native prefix under the target converter preserves every already captured source effect, normalized event and attachment dependency. Only then can converter checkpoints be rebuilt and the binding continue with its original epoch, sequence and acknowledged prefix. Unknown compatibility must fail explicitly. A changed filter can invalidate prior content, offsets and artifact hashes; replacing a version string or filter fingerprint is insufficient.

For a changed projection, the workflow must create and verify a replacement recording from retained native history under the new policy, with explicit lineage/provenance and an explicit disposition for the old recording. It must not silently append corrected text while leaving the old sensitive projection accessible. Existing exports, backups and downloaded copies cannot be rewritten through recording removal. The replacement must use fresh event/source mappings and artifact dependencies and preserve retry identity across interruption.

Import-origin relocation must distinguish moving the same verified native source from selecting different source content, changing artifact roots or moving the server. Validate native identity and frozen prefix before updating paths; do not infer identity from filenames. Server relocation requires destination ownership/revision handling and credential origin checks, not just a path edit.

## Acceptance needed before enabling migration

Use real CLI invocations and durable fixtures for unchanged-prefix compatibility, changed text/filter/artifact output, source truncation/replacement, family scope changes, origin/path relocation, old credential failure, interrupted staging, lost network acknowledgement and restart. Compare complete normalized histories and attachment hashes, and verify that existing binding state is untouched on rejected migration. Test import retries and resumed live capture after a successful migration.

OpenCode revert projection, import-result unfinished-text counts and persisted viewer/archive completeness notices (below) are implemented. Broader native fidelity remains open. Future conversion changes must participate in compatibility/version policy rather than silently changing replay under an existing converter identity.

## Import completeness notices

Native imports (Claude, Codex, Kimi, OpenCode, including family imports) append one `capture.completeness` event after the converter output and before the server ends the recording. It is emitted only when the frozen boundary leaves work unfinished. Counts cover the complete durable normalized prefix, including children: visible messages that never completed, visible tools still running, and (OpenCode only) messages whose redaction tail is withheld. The event carries counts and a fixed reason only. It reuses the last imported event's clock, so its timeline position is the frozen boundary. Its journal record keeps the converter checkpoint unchanged. Explicit import-to-live continuation reopens the recording, and reducers clear the notice at that point; unfinished work that remains visible at a later ended boundary is covered by the viewer-derived notice.

This is import finalization, not converter output. Converter version strings (`claude-history-4`, `opencode-snapshot-4`, …) are unchanged, so import/live continuation mappings and live converter checkpoints are unaffected. The notice is pinned separately: new import manifests (`import.json`) record `completenessNotice: 1`, and only such bindings emit it. A binding whose manifest predates the field is treated as legacy. Retries compare against the legacy identity and emit nothing, so an already ended legacy import is not reported as missing events and its history is unchanged. Retries of new bindings recompute identical counts from the pinned source and durable journal. They resolve to the same stable journal source key (`agentlive-import-completeness-1`) and add no event. Changed counts for the same key are rejected as a changed-content retry. Replacement migration (`migrate-import`) creates a new binding and therefore emits the notice under the current policy.

Limits: an interrupted legacy replacement that saved its intent but not its target `import.json` before upgrading will see a changed target policy hash and must be restarted with a new operation. Tasks, pending interactions and pending attachments are not counted. A server older than this protocol change rejects the new event kind, so imports into such a server fail rather than dropping the notice.

## Verify a candidate native source

```sh
agentlive inspect-migration --source /path/to/publisher-binding-directory \
  --native-source /path/to/moved-native-export
```

For bindings with a frozen import manifest, this hashes exactly the recorded prefix using bounded reads under the publisher lock. An exact match ties the candidate bytes to the saved import boundary. It reports `verification: "frozen-import-prefix"`, verified byte count, remaining byte count and whether the boundary ends on a newline. OpenCode exports require the exact frozen size. JSONL sources may have a suffix only when the frozen prefix ends at a complete-line boundary. Closed exports without a final newline can still match at their exact original size.

Truncated or changed prefixes, nonregular files, symlinked candidates and detected file changes during inspection fail. Cancellation is supported. This verifies the frozen bytes only: appended content, child sources, artifact roots, converter checkpoints and remote state remain unverified. The candidate should remain quiescent during inspection; metadata checks are not a filesystem snapshot or a guarantee against a writer that restores timestamps. Migration execution must revalidate its source rather than trusting an earlier inspection result.

## Verify pinned family sources

Add `--verify-family` alongside `--native-source` to verify every child listed in the import manifest. The command uses each child's saved path and frozen boundary and applies the same exact-export or JSONL-prefix rules as the root. It rejects duplicate child identities, malformed manifests, unavailable sources and changed prefixes. Family size is bounded to 199 children. The report adds aggregate verified-source, verified-byte and remaining-byte counts and uses `verification: "frozen-import-family-prefixes"`; child paths and content are not returned.

This verifies the pinned child bytes, not native parentage, newly discovered children or appended suffixes. Moved child paths can be supplied explicitly for inspection as described below. A root-only inspection does not read family paths; the family check is explicit. Artifacts, converter compatibility and remote state remain separate migration requirements.

### Inspect moved child sources

Repeat `--family-source child-id=path` with `--verify-family` and `--native-source` to override saved child paths for this inspection. Use the exact native child identity from the import manifest. The first `=` separates identity from path, allowing `=` within paths. Unmapped children still use their saved paths.

Unknown/duplicate identities, more than 199 mappings, missing files and changed bytes fail. Mapping does not weaken the frozen-prefix check. Inspection leaves the import manifest unchanged and does not claim that child parentage or artifact paths have migrated. Keep the mapping for the eventual migration operation; successful inspection alone is not a durable relocation.

## Commit frozen-import child relocation

```sh
agentlive relocate-import-sources --source BINDING_DIR \
  --native-source ROOT_FILE --family-source CHILD_ID=MOVED_FILE \
  --operation-id UNIQUE_OPERATION_ID --expected-manifest-hash IMPORT_MANIFEST_HASH
```

Use `imported.manifestHash` from inspection. This operation verifies the root and all pinned children under the publisher lock, then changes only the explicitly mapped child `sourcePath` fields in `import.json`. Native IDs, source hashes, converter/filter settings, artifacts, recording identity and event journals are preserved. Unmapped children must still be available. Bindings with `publish.json`, any import-resume transition or pending credential rotation are rejected.

Before replacing the import manifest atomically, the command saves `relocate-import.json` with the operation ID, before/after hashes and path mappings. Repeat the exact arguments after an uncertain result; it accepts either the original manifest or the already-committed target manifest and completes the receipt. A different request cannot replace an unfinished intent. An outdated expected hash cannot change a newer manifest. Only the most recent relocation receipt is retained; repeat an older operation after subsequent relocation is not supported.

This moves recorded child-source pointers only. It does not move files, change the root source or artifact base, rewrite family parentage, or update live converter checkpoints. Keep explicit artifact roots/base unchanged when retrying import. A real OpenCode family import test verifies relocation followed by an identical import result and archive round trip. Other agents' location-derived discovery rules, full crash/IO-failure injection and import-to-live continuation after relocation still require acceptance.

Relocation now checks Claude and Kimi destination layouts before saving intent: Claude children must use `<root-source-directory>/<session-id>/subagents/agent-<child-id>.jsonl`; Kimi must retain `session_<id>/agents/main/wire.jsonl` for the root and the sibling `agents/<child-id>/wire.jsonl` child layout. A hash match alone cannot authorize an incompatible layout. Codex relocation requires `--source-root` and validates proposed child paths through native family discovery, as described below.

OpenCode family continuation is integration-tested after child relocation: explicit resume reopens the same recording, unchanged snapshots add no duplicate imported effects, restart captures new root/child activity, and the complete pre-resume event prefix remains identical. The native API is a synthetic fixture; actual native-process and cross-version acceptance remain open.

### Codex relocation and live continuation

For Codex, add `--source-root ROLLOUT_DIRECTORY` to `relocate-import-sources`. Before saving intent, discovery must find the selected root at the supplied root file and each imported child at its proposed path. It rejects ambiguous histories, skipped/truncated discovery, missing/cyclic parent chains, mismatched logical session or thread identity, and unrelated copied thread metadata. These are the discovery and lineage rules used by live family capture. The root is required again for retries so the current family is revalidated.

A file-based integration test moves a Codex child, commits relocation, resumes the original import, then restarts live publication and captures appended activity. Existing changed-prefix and source-validation checks continue to run against the moved file. This is synthetic native-file acceptance, not an actual Codex process/version acceptance result. Artifact base/root policies are unchanged by source relocation.

Relocated file-family continuation acceptance (2026-09-11): all 10 inspection/family-resume tests pass. Claude and Kimi source trees and the Codex child source are relocated before live continuation. Resume and restart retain the same recording and exact full imported event prefix, capture new activity, and preserve explicitly pinned original artifact policies. Evidence is synthetic native files; actual process/version, general converter/filter/server migration and full production acceptance remain open. Benchmarks paused.

## Replace a frozen import with a new projection

```sh
agentlive migrate-import --source BINDING_DIR --native-source ROOT_FILE \
  --operation-id UNIQUE_ID --expected-manifest-hash IMPORT_MANIFEST_HASH \
  --old-recording retain --redact-env NEW_REDACTION_VALUE
```

The named environment variable supplies one additional exact redaction value (8–4096 characters); repeat `--redact-env` for more values. Automatic environment-secret filtering still applies. The current installed converter produces a new private, ended recording with fresh event mappings and artifact dependencies. The source recording's event history, binding and import manifest are unchanged. The replacement title is filtered too. Artifact roots/base default to the original manifest; pass artifact options explicitly to change them, and reselect bundle/remote-artifact policy if needed. The replacement never inherits public visibility or viewing credentials.

Choose `--old-recording retain` to explicitly keep the original accessible under its existing policy, or `--old-recording remove --confirm-removal` to remove it after the replacement has durably uploaded and ended. Removal does not erase prior exports, backups or downloaded copies. The original remains accessible until removal completes; retry an interrupted operation using exactly the same arguments and filter environment.

The command holds the source publisher lock throughout. It requires an imported binding with no live/resume or credential transition, exact frozen source lengths and hashes, and unchanged native identity and family scope. Appended histories are rejected. Claude/Kimi use their native family layout; Codex/OpenCode family imports additionally require `--source-root`. Both operator credentials and account files are accepted; any explicit `--server` must match the original origin.

Before remote creation, `replacement-import.json` saves the source revision/manifest hash, operation identity, disposition, target policy hash and deterministic target directory. It saves the target receipt before removal. Lost target acknowledgements reuse the same import journal; lost removal responses retry the same removal operation. Changed source/policy/options cannot silently adopt a pending operation. Only one replacement operation is retained per source binding; a subsequent policy migration should start from the replacement binding. The receipt returns its `publisherDirectory`, which contains `migration-origin.json` with source lineage. The new binding can use the normal import/resume workflow with its new policy.

Current evidence: 14 focused tests cover exact-prefix relocation and replacement families across all four agents, changed message/title filtering, changed OpenCode artifact bytes, private target visibility, retained/removed source disposition, actual CLI retries, appended-source rejection, changed-policy rejection and a lost removal response after the server committed removal. Eighteen CLI/OpenCode tests passed separately. TypeScript, browser/package builds and isolated-install/reproducible-rebuild checks pass; the installed-package probe now also executes replacement migration, confirms stable retry identity and replays redacted target text.

Limits: same-sequence compatibility proof/checkpoint rebuild, existing live-binding replacement, archive-only server transfer without native history, arbitrary family-scope change and full process-death/storage-fault acceptance remain unfinished. Server/archive lineage is implemented as described below. A completed replacement is a feature checkpoint, not general migration or production-gate completion. Inspection's `migrationImplemented: false` continues to mean that general migration is incomplete.

The subsequent full regression passed all 673 tests across 128 files (232.20 seconds, one worker). Production code was unchanged during that run. This is local correctness evidence, not full production acceptance.

## Server and archive lineage

After replacement upload, `migrate-import` posts immutable lineage to `POST /api/v1/streams/:id/migration-origin` before attempting source removal. Only the target owner/operator can attach it, and the initial request also verifies ownership of the source plus its ended lifecycle and revision. The target must be a different, private, ended recording. The request carries the current target revision; changing a saved lineage record is rejected. Exact retries work after source removal because they compare the saved lineage without reopening the source.

Recording metadata exposes `migrationOrigin` containing operation ID, source recording/revision, source/target converter versions and `requestedSourceDisposition`. This is an owner-declared relationship, not server proof that the converter reproduced every source effect. The disposition records the requested action, not proof of successful removal. Native paths, write credentials, filter values and filter fingerprints are not included. Metadata callers receive a copy. Export copies this field into archive provenance, archive import retains it, and offline backup/restore preserves its original historical references even when restore assigns new recording revisions.

If lineage persistence fails ambiguously, subsequent session reads/mutations fail until the store reopens; a possibly committed record cannot be overwritten from stale memory. Tests cover failures before and after metadata replacement, exact retry after reopen, conflicting lineage, stale target revisions, publisher/cross-account denial, lost lineage/removal responses, archive round trips and operational backup/restore. The fault fixtures initially used the wrong creation lifecycle sequence; corrected fixtures pass both persistence cases. Focused suites, TypeScript/browser/package builds and isolated-install/reproducible-rebuild verification pass. The installed-package migration now runs through lineage persistence too. The prior full 673-test run predates this lineage addition.

## Replace an import on another server

```sh
agentlive migrate-import --source SOURCE_BINDING --native-source NATIVE_FILE \
  --operation-id UNIQUE_ID --expected-manifest-hash SOURCE_MANIFEST_HASH \
  --old-recording retain --target-server https://destination.example \
  --target-owner-file /private/destination-owner.json
```

Source authorization continues to use `--owner-file`, `--account-file` or the existing owner environment setting. Select exactly one destination credential file: `--target-owner-file` for its operator credential or `--target-account-file` for an account credential bound to the destination HTTPS origin. Cross-server replacement requires an explicit destination credential and checks destination listing authorization before persisting a new intent. Source credentials authorize source inspection/removal; destination credentials authorize target creation, upload and lineage. Both values participate in redaction. Source and destination need not share credentials or account identities.

The saved request pins the destination origin; a retry with a different server fails before network work. The target receives a private recording with a fresh identity and verified native root/family scope. `externalSource` records the original server origin and `verification: "owner-declared"`. The source CLI validates source ownership/revision, while the destination stores the owner's external-source declaration without contacting that server. Local lineage still uses the local ownership checks. Archive export retains the external origin. `--old-recording remove --confirm-removal` removes the original only after destination upload, ending and lineage persistence succeed.

New receipts include `targetServerOrigin` and `stateDirectory`, alongside the exact `publisherDirectory`. To continue on the destination, use the returned state directory with `publish --resume-import`, the destination server/credential, the original native source and the same title/filter/artifact settings. Keep the original source credential in the redaction dictionary when it participated in migration (for example through an environment name ending in `_SECRET`), even when it no longer authorizes the source server. Normal restarts then use the same destination state directory without `--resume-import`.

Older replacement layouts remain retryable at their original directory and return `stateDirectory: null`; they retain the programmatic `publisherDirectory` workflow. The operation never silently moves an existing journal to a new path.

Nineteen focused migration/inspection/account/family tests pass, including two actual HTTP servers with separate credentials, retain/remove dispositions, bad/missing destination credentials before intent, destination-switch rejection, private filtered output, external archive provenance, exact CLI retries, and destination live continuation/restart with full imported-prefix equality. Initial tests expected 401 for a source credential presented to the destination; the server correctly returns 403 and the assertions now match it. Legacy directory retry compatibility passes. The native transcripts are synthetic fixtures. This workflow recreates frozen imports under the current converter and selected policies; live-binding migration and archive-only transfer remain separate work.

Final TypeScript/browser/package and isolated-install/reproducible-rebuild checks pass. The installed-package probe covers replacement migration on one server; the two-server workflows are tested through the built CLI.
