# OpenCode reverted snapshots

AgentLive's production OpenCode snapshot capture interprets `info.revert.messageID` and optional `partID`. The boundary follows OpenCode 1.18.30's [SessionRevert.cleanup implementation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/revert.ts):

- With only a message ID, that message and subsequent messages are excluded from the current projection.
- With a part ID, preceding messages remain, and the target message retains only parts before that part. The target part and subsequent messages are excluded.
- When revert metadata disappears, retained native objects become visible again through the existing snapshot reconciliation path.

The snapshot converter validates the boundary before capturing effects. Missing target messages or parts fail explicitly. Native snapshot order determines the boundary; ID sorting is not substituted. Source snapshots are not mutated, and native filesystem snapshot/diff metadata is not automatically published.

An import that first observes a reverted snapshot captures its retained prefix. Live capture that observed the full snapshot earlier hides reverted objects using existing object visibility events; partial-message reverts reconcile the retained text/parts. Earlier recorded content remains available in history. Native revert is not a privacy deletion operation, and already shared content is not withdrawn.

The change uses existing stable object IDs and monotonic snapshot generations. Snapshots without revert metadata keep their existing conversion. Previously captured revisions are never rewritten; a new reverted snapshot adds normal reconciliation effects. Previously completed imports are not retroactively reprocessed merely by installing the new code. General converter/filter migrations remain unfinished.

Tests cover message and part boundaries, initial reverted capture, duplicate snapshots, capture reopen while reverted, unrevert, and malformed targets. Related OpenCode family-import and publisher tests pass. The boundary semantics are verified against the installed version's tagged source; an interactive revert/unrevert journey with the native process, richer media/part cases, concurrent native cleanup and cross-version acceptance remain open.

## Frozen unfinished text

OpenCode import reports include `unfinishedMessages` and `withheldTextMessages`, aggregated across the root and imported children after applying revert boundaries. The first counts assistant messages without a native completion timestamp. The second counts those messages whose streaming redactor has a buffered suffix at the frozen boundary, including native error text. Counts reveal neither the suffix nor the matched credential. Completed and reverted-away messages do not contribute.

An ended AgentLive import does not imply that the native assistant message finished. Import retains only the safe emitted prefix; it does not flush a potential secret prefix to make the recording look complete. The normal explicit import-to-live continuation can later reconcile text when native completion or additional text resolves the buffered suffix. Import retries recompute the same counts from the pinned source and do not add events or alter existing source-effect identities.

These counts appear in the import result JSON. New imports also persist a content-free `capture.completeness` event as the last imported event. It carries `withheldTextMessages` from this report. Its `unfinishedMessages` and `unfinishedTools` are counted over the normalized recording: visible messages that never completed and tools still running, so they can differ from the report's native `unfinishedMessages` count. Explicit import-to-live continuation reopens the recording, which clears the notice at later boundaries. Terminal replay/watch and the browser show the notice. Archive export copies it into `provenance.completenessNotice`. Bindings imported before this change keep their original output on retry; see [converter-migrations.md](converter-migrations.md#import-completeness-notices). General converter/filter migrations and broader native completion acceptance remain open.
