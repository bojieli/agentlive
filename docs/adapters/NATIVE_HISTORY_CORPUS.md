# Native-history compatibility corpus

The user authorized read-only testing against all discoverable local sessions. Raw histories and exported artifacts remain local under ignored paths. Do not upload them to GitHub or include transcript text in aggregate reports.

The first inventory on 2026-09-09 used the bounded JSONL source reader:

| Source | JSONL files | Parsed records | Largest record, bytes | Parser failures |
| --- | ---: | ---: | ---: | ---: |
| Claude project histories, including nested files | 1,588 | 435,207 | 8,605,789 | 0 |
| Codex current session directory | 506 | 602,412 | 16,761,972 | 0 |
| Kimi Code session directory | 458 | 158,248 | 213,117 | 0 |

A further archived Codex file (194,465 bytes at inventory) was discovered and added to the scanner's roots. OpenCode's session-list/export interface enumerated and exported both local sessions; those exports contain four messages and two text parts. The initial OpenCode export inventory used the locally installed CLI. The compatibility matrix separately records the latest npm version used for live probes.

These counts are structural inventory, not successful import/rendering assertions. The corpus changes as agents continue working. The scanner freezes each file's size at opening, reports malformed or oversized files, and defers partial final records; it does not claim a filesystem-wide atomic snapshot. A subsequent conversion report must identify which retained records were converted, intentionally excluded by policy, unsupported, or unavailable.

## Findings that must drive conversion and rendering

- Claude histories include tool use/results, images/documents, thinking blocks, file-history snapshots/deltas, attachments, asynchronous queue operations, bridge sessions, agent names, artifact comment monitors, and artifact autoreaction ledgers. These are not all ordinary chat messages.
- Codex histories include structured completed items alongside lower-level response items. Converters must choose an authoritative representation and avoid counting both as separate effects. Observed items include commands, file changes, MCP calls, subagent activity, collaboration calls, image views, extensions, and compaction. Aborted turns and goal/status changes are also present.
- Kimi histories include context messages and loop events, task start/termination/wait delivery, interactions and approvals, canceled/interrupted/retrying turns, swarm modes, goals, plan revisions, usage, and compaction. LLM request records and configuration/authentication material must not be blindly broadcast.
- Native records can be much larger than the server's event-batch limit. A bounded parser alone is insufficient: normalization must split text safely, handle binary content as attachments, preserve tool/object identity, and retain explicit truncation/unavailability reports when source data cannot be represented.
- Monitor, credit/authentication error, resumed-session, subagent, image, document, and artifact cases need actual conversion and viewer assertions. Their presence in an inventory is not test coverage.

Run `npx --yes pnpm@12.3.4 build` then `node scripts/inventory-native-history.mjs` to refresh local structural reports. This is opt-in local work and is not part of model-free CI. It reads source files without rewriting them and stores per-file reports using hashed path identifiers. The report content excludes transcript text and credentials.


## Codex conversion and private-import pass

`node scripts/validate-codex-history.mjs` now converts the full discovered Codex corpus locally through the same normalizer used by live capture. The latest pass included 510 files (the active corpus grew after the initial inventory) and emitted 257,375 normalized events. It checks event schemas, per-event size, immutable source-effect retries, and message/tool lifecycle starts without publishing source data.

The first pass failed on 89 files: 71 exceeded the normalized-event size threshold, five failed event shape/size validation, 12 contained related native threads under one logical session, and one needed legacy aborted-turn message handling. After bounded text replacements, logical-session identity handling, and legacy recovery were added, the latest pass had zero conversion failures.

Remaining explicit unsupported/unavailable coverage: 1,348 image-view items, 1,361 extension items, three local-image user blocks, one skill user block, and 91 goal updates. Successful structural conversion does **not** mean those objects render fully or their artifact bytes are available. It also does not prove semantic equivalence of every original vendor view, large-state memory bounds, or the other three agents' converters. Those remain acceptance requirements.

A separate real archived session passed `scripts/probe-history-import.mjs`: the source was read without changes, converted and stored through a local private server, replayed through the reference reducer, then imported again with the same identity and no additional events. Unauthenticated access was denied. The result retained 11 messages and 15 tool results across 71 stored events; an unavailable skill reference was reported. This is full storage/replay evidence for that session, separate from the corpus-wide structural pass.

### Local image import checkpoint (2026-09-09)

Codex native `ImageView` paths and user `local_image` blocks now use the durable attachment resolver during import. The importer stages privately, captures within explicit source roots, uploads immutable bytes before availability events, records message reference mappings, and only shares after ending the recording. Available/missing outcomes are checkpointed so retries preserve the same event content. Import format version 2 includes source-root/base-directory and secret-filter fingerprints; an existing version 1 import needs explicit migration/new import, rather than silently changing its history.

A real local Codex recording with image references passed private import, replay, and repeat import: 114 source records, 34 items, 65 producer events, 67 stored events, 7 messages, 15 tools, and 2 unavailable artifacts. There were no unsupported-item entries or capture gaps in this recording. A read-only search found no accessible original files for the local corpus's ImageView paths, so this run proves missing-file representation and stable retry, not historical image recovery. A synthetic end-to-end native recording separately verifies downloaded image bytes, resolved user-message references, and unchanged replay after the source disappears or a previously missing file appears.

Image resolution currently handles local files (including file URLs); inline/base64 images, remote provider artifact URLs, HTML bundles, and viewer presentation remain separate unfinished requirements. Current files without historical content hashes are labeled `current-file`. The structural corpus runner has no file resolver and therefore reports image references as unavailable instead of testing their bytes.

Post-integration structural rerun: all 510 discoverable Codex histories converted with zero failures, producing 260,161 normalized events. Remaining unsupported reports were 1,391 Extension items, one skill user block, and 91 goal-update records. Source histories are live and may grow between runs. ImageView/local-image records now produce typed attachment outcomes; this run still does not establish browser/terminal rendering or recovery of absent historical bytes.

### Retained history into file following

`followCodexHistory` uses the same stateful record consumer as closed-file import. It rebuilds retained history before its catch-up callback and continues through new complete lines; partial records remain pending. On publisher restart it rebuilds converter state from history, while the durable journal deduplicates source effects. The native transport selects `structured` or `legacy` record format explicitly for initially empty histories. This API assumes an existing bound publisher journal and does not yet provide automatic native-session discovery.

The synthetic test appends a new native completed message after catch-up, verifies its capture, closes/reopens the publisher, and verifies no duplicate events. A real archived source separately passed two read-only attachments with 110 records and 69 producer events. Full source-prefix verification on changed files is currently a known performance cost; no multi-gigabyte sustained-follow performance claim is made.

### Claude native conversion foundation (2026-09-09)

Read-only structural conversion ran across all 1,588 discovered Claude JSONL files. 1,553 converted, producing 409,036 normalized events. The other 35 lack standalone session identity or timing: 28 bridge-only files, one bridge/mode file, three bridge/cost files, and three started/result ledgers. They remain reported failures for standalone conversion, not silently omitted or counted as converted sessions; ledger association is unfinished.

The converter supports user/assistant text, tool calls and failed/successful results, readable system notices/API error messages, bounded large-text framing, secret filtering, and stable retry identities. Reasoning/signatures are omitted by default. Nested tool result blocks are handled through explicit text selection and unsupported reports, preventing raw image/base64 or other opaque envelopes from leaking into text output. Missing retained calls get a placeholder and explicit gap; a later call reconciles input without a duplicate tool start (the placeholder name remains a limitation).

Remaining unsupported reports include 50,038 attachment records, 3,347 file-history snapshots, 1,250 file-history deltas, 6,879 queue operations, 2,021 nested tool-result images, 1,016 tool references, artifact monitors/ledgers, agent names, and other source objects. These counts are evidence of remaining work, not full compatibility. Inline attachment conversion, typed monitor/subagent/queue behavior, multi-file parent/child association, import orchestration, live following, and actual rendering remain required. Source files stayed unchanged and only aggregate findings are committed.

### Claude private import and replay (2026-09-09)

Claude and Codex now use the same import orchestration for manifest validation, private creation, durable publisher upload, acknowledged-prefix reconciliation, end-of-recording commit, and subsequent sharing. `importClaudeRecording` is a programmatic API; CLI/viewer integration remains unfinished. The shared extraction preserves the existing Codex version-2 manifest format and its image resolver.

Two real Claude recordings passed isolated local private import, reducer replay, retry deduplication, and anonymous-access rejection. One API-error recording had 14 source records, 20 producer events, 22 stored events, 5 messages, and 4 unsupported gaps. A recording containing tools and API errors had 178 source records, 203 producer events, 205 stored events, 33 messages, and 38 tools. Its 27 gaps correspond to 12 queue operations, 6 attachment records, and 9 tool references. This proves the implemented text/tool/error path through storage and replay, not complete artifact or queue semantics and not UI rendering. Source files were unchanged; raw probe output remains local/private.
