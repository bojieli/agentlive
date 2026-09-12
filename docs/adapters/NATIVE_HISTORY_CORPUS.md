# Native-history compatibility corpus

The user authorized read-only testing against all discoverable local sessions. Raw histories and exported artifacts remain local under ignored paths. Do not upload them to GitHub or include transcript text in aggregate reports.

The first inventory on 2026-09-09 used the bounded JSONL source reader:

| Source                                           | JSONL files | Parsed records | Largest record, bytes | Parser failures |
| ------------------------------------------------ | ----------: | -------------: | --------------------: | --------------: |
| Claude project histories, including nested files |       1,588 |        435,207 |             8,605,789 |               0 |
| Codex current session directory                  |         506 |        602,412 |            16,761,972 |               0 |
| Kimi Code session directory                      |         458 |        158,248 |               213,117 |               0 |

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

### Claude inline attachment import (2026-09-09)

Claude import version 2 resolves supported base64 image/document message blocks to immutable server attachments. Supported declared media types are PNG, JPEG, GIF, WebP, PDF, plain text, and SVG; this is byte capture, not image decoding or inline-preview validation. Text/SVG bytes are filtered before local persistence. Canonical base64 and size checks precede capture, opaque bytes never enter text events, and message references follow durable upload. Other source encodings/media forms remain explicitly unavailable. Native separate attachment records and nested tool images still require conversion.

A real local Claude source passed private import/replay/retry with 79 source records, 66 producer events, 68 stored events, 10 messages, 14 tools, and one downloaded attachment verified against its stored byte size/hash. It retained five unsupported gaps: one file-history snapshot and four separate attachment records. The source file remained unchanged. Synthetic tests also cover invalid base64, immutable input copies, text filtering, and repeat import. No browser image rendering claim is made.

### Kimi native history conversion and import (2026-09-09)

Kimi wire protocol 1.4 and 1.5 records now have preflight, conversion, and shared private-import APIs. Source identities come from the native session/agent directory layout or an explicit identity for moved exports. The converter retains message text, assistant text parts, tool arguments/results/errors, source truncation notices, timestamps, and per-file agent identity. Known raw configuration and reasoning remain omitted. String and content-array tool outputs are supported; non-text parts receive explicit unsupported reports.

All 458 discovered local wire files passed structural conversion, emitting 97,503 normalized events. The initial 13 failures exposed array-valued tool outputs and were fixed. Remaining unsupported reports include 108 tool-result image references, task/goal/approval/swarm/plan events, source turn lifecycle events, and runtime/telemetry records. These are not full-semantic-coverage or UI-rendering results. Source histories and private data remain local.

A real Kimi recording passed private import, reducer replay, repeat-import deduplication, and anonymous-access rejection: 38 source records, 31 producer events, 33 stored events, 6 messages, and 4 tools. Its three gaps were runtime binding, plugin session start, and turn end. The synthetic integration test also checks failed tools, truncated/array outputs, filtering, agent association, and reasoning omission. Multi-file parent/child session merging, source lifecycle semantics, attachments, live capture, and viewers remain unfinished. A single-file import binds to the native session; importing a different agent file into that binding is deliberately rejected by the source manifest until explicit multi-file orchestration exists.

### OpenCode exported-session import (2026-09-09)

OpenCode's native `info`/`messages` JSON export now has inspection, normalization, and shared private import. The converter validates message/part ownership and unique identities, freezes a bounded export before capture, retains text/tool/error content and source times, filters known secrets, and reports unresolved file references and unknown parts. Tool-state fields were checked against the upstream [session schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts). The current parser caps exports at 64 MiB; larger exports need a streaming parser. File/artifact resolution, newer incompatible export formats, subagent associations, and live integration remain unfinished.

The installed CLI freshly listed and exported both local sessions using `session list --format json --pure` and `export <id> --pure`. Both passed isolated private import, reducer replay, anonymous-access rejection, and duplicate-free retry. Each contained two messages and one text part, producing eight producer events and ten stored events. These histories contain assistant errors and no tools, so real tool/export coverage is not established. The synthetic integration test covers failed tool states, unresolved files, secret filtering, rejected foreign part identities, and oversized exports. Native databases were not edited; raw exports remain local/private.

### Full normalized reducer and terminal-render corpus pass (2026-09-09)

`node scripts/validate-native-replay.mjs` invokes every converter, constructs sequential stored-event envelopes with reconstructed timing, applies the playback reducer, and calls the terminal event renderer. It checks event schemas, output frame limits, source-effect conflicts, replacement completion, and absence of terminal control sequences. It does not publish these histories or resolve source attachments. Raw rendered text is hashed and discarded; private aggregate reports are under `probe-results/native-replay-validation`. The command returns nonzero when any file fails.

| Agent    | Files checked | Passed | Rejected | Normalized events | Messages |  Tools |
| -------- | ------------: | -----: | -------: | ----------------: | -------: | -----: |
| Codex    |           510 |    510 |        0 |           263,228 |   19,508 | 56,987 |
| Claude   |         1,588 |  1,553 |       35 |           409,036 |   43,804 | 96,918 |
| Kimi     |           458 |    458 |        0 |            97,503 |   13,771 | 19,445 |
| OpenCode |             2 |      2 |        0 |                16 |        4 |      0 |

The rejected files are the previously classified Claude bridge/bookkeeping and started/result ledgers with missing standalone identity or time. The pass produced 1,294,172,567 bytes of terminal text for hashing, without retaining that text. It includes 89,828 explicit gaps and 1,840 unavailable artifact states, so passing does not imply complete raw-object support. This run is evidence for normalized event/reducer/render compatibility. Full source semantics, ledger/parent-child association, attachment conversion, the CLI's large-recording capacity, and browser/interactive playback still require work. Original sources were unchanged.

### Typed task and goal replay (2026-09-09)

The protocol and reducer now retain task and goal snapshots. Kimi task start/termination records preserve task type, description, status, detached state, and recorded agent ownership, with linked tool input/output. Killed tasks map to interrupted; timeouts remain distinct in task state. Native `outputTail` is labeled as the retained tail. Goal create/update/clear records retain objective, status, reason, optional completion criterion, and usage counters across partial updates. Codex native `thread_goal_updated` records use the same goal representation, converting source elapsed seconds to milliseconds. Unknown or unassociated source state still requires explicit handling.

The updated Kimi replay/render corpus passed all 458 files: 98,047 events, 19,717 tools, and 9,781 gaps (previously 15,609). The added tool count represents 272 recorded background tasks. The Codex rerun passed all 510 histories; its active source corpus continued growing during development, so totals are not a fixed before/after comparison. A real Kimi recording containing goals passed private import/replay/render/retry with 179 source records, 22 messages, 24 tools, two tasks, and one goal. It retained 25 gaps for runtime/telemetry, turn lifecycle, and tool-store records.

Import converter identities advance to Codex history 3 and Kimi history 2. Existing imports from older converter versions are explicitly rejected for reconciliation rather than silently rewriting their stored histories; migration remains required. Cross-file parent-child association, approvals, plans, swarm coordination, monitors outside these task records, and browser presentation remain unfinished.

### Recorded interactions and plan revisions (2026-09-09)

Kimi approval requests, approval-result audits, question requests, and recorded answers now use `interaction.updated` snapshots. Requests retain prompts, available choices, tool/agent association, response, and scope. Result audits associate with a retained request by tool identity when possible. These are passive replay records; no viewer approval/action endpoint is introduced. Plans retain active/inactive state and revision number, original hash, byte count, and source reference. Both native `key` and `path` reference fields are supported.

During import, a plan file within configured roots is captured only if its bytes match the recorded source hash. Text is filtered before upload, and plan state links to the announced immutable attachment version. Missing/inaccessible/mismatched files remain unavailable. Server publication and replay reject plan references to unannounced versions. The synthetic integration test verifies a downloaded filtered plan and retry after source deletion. The Kimi converter identity is now history 3; earlier import versions require explicit reconciliation.

The normalized Kimi corpus pass succeeded for all 458 files, producing 98,061 events with 9,667 gaps and seven unavailable plan attachments in the resolver-free validation run. A real recording containing interaction and plan events passed private import/replay/render/retry: 424 source records, 302 producer events, 304 stored events, 39 messages, 49 tools, six tasks, one interaction, and one plan. Its plan artifact was unavailable; 65 remaining gaps cover runtime, telemetry, tool-store, and turn lifecycle records. This does not establish full interaction semantics for the other agents, multi-file relationships, live operator control, or browser behavior.

### Reopening and visibility regression pass (2026-09-09)

After adding reopened-object and presence transitions, the read-only conversion → reducer → terminal pass was repeated against every file discovered by the configured local roots:

| Source                                      | Files | Passed | Failed | Normalized events | Explicit gaps | Unavailable artifacts |
| ------------------------------------------- | ----: | -----: | -----: | ----------------: | ------------: | --------------------: |
| Codex, including archived histories         |   512 |    512 |      0 |           267,758 |         1,488 |                 1,467 |
| Claude, including nested histories          | 1,591 |  1,556 |     35 |           409,111 |        72,730 |                   409 |
| Kimi wire histories                         |   460 |    460 |      0 |            98,117 |         9,686 |                     7 |
| OpenCode exports from discovered workspaces |    12 |     12 |      0 |               129 |             0 |                     1 |

The 35 Claude failures still report missing standalone session identity or timestamp; parent-session association remains required. The validator correctly exits nonzero for those failures. Passing files may contain explicit unsupported gaps and unavailable attachments; this is not complete semantic coverage or attachment-download validation. OpenCode discovery is workspace scoped, not a claim of exhaustive discovery of every unknown workspace. Local reports are refreshed in ignored `probe-results/native-replay-validation`; transcript rendering is hashed and discarded.

### Reconstructed-state renderer pass (2026-09-09)

The corpus validator now also renders each final reconstructed state, checks terminal-control escaping, and retains only byte counts and hashes for that rendering. It covers the same reducer state used by initial timeline seeking. The refreshed results are:

| Source                      | Passed / files | Snapshot bytes hashed |
| --------------------------- | -------------: | --------------------: |
| Codex                       |      512 / 512 |           691,136,409 |
| Claude                      |  1,556 / 1,591 |           326,816,302 |
| Kimi                        |      460 / 460 |            81,212,536 |
| Discovered OpenCode exports |        12 / 12 |                12,230 |

The 35 Claude failures retain the missing identity/timing category. Unsupported source gaps and unavailable artifacts remain explicit; successful snapshot rendering does not establish complete native-object coverage. Byte counts are cumulative across files, not peak memory claims. No rendered corpus transcript is saved or uploaded.

### Claude retained files and embedded plans (2026-09-09)

Read-only shape inspection found 340 text-file attachment records, 1,004 edited-text snippets, and 22 embedded plan references across the discovered Claude corpus. The file records retain content plus start/count/total line metadata. They are now converted from recorded bytes into explicitly labeled excerpt/snippet attachments; embedded plans become Markdown attachments with typed plan references. The activity status is unknown unless separately established. Other attachment categories, including reminders, queued commands, environment/configuration material, and monitor-related records, are not blindly forwarded as files.

The refreshed conversion → reducer → event/snapshot renderer pass processed 1,592 files: 1,557 passed and the same 35 failed standalone identity/timing preflight. It emitted 414,506 normalized events, with 71,405 explicit gaps and 1,746 unavailable attachment representations in this resolver-free validation. The increase in unavailable representations includes newly recognized retained bytes that need an artifact resolver; it does not mean those bytes are absent from the native file.

A selected real existing session containing all three new attachment forms passed private HTTP import, replay, retry deduplication, and download verification: 715 source records, 544 producer events, 546 stored events, 33 messages, 127 tools, one plan, and four downloaded attachments verified. Its 177 remaining gaps comprise 143 other attachment records, eight queue operations, six file-history records, three turn-duration records, and 17 agent-name records. No raw session contents were committed.

### Claude artifact monitor observations (2026-09-09)

Shape inspection found 32 version-1 comment-monitor snapshots, all with native state `armed`, and 47 automatic-reaction ledger snapshots with empty thread/turn queues. The latter retain baseline/thread-observation flags and optionally interruption. These now normalize to monitor snapshots; future or non-empty ledger structures remain explicit unsupported records. No account identifier is broadcast and no monitoring/reaction action is performed.

A real existing 325-record session containing both kinds passed private import/replay/retry: 220 producer events, 222 stored events, and two retained monitor identities. Its 39 remaining gaps belong to other attachments, file history, tool references, frame links, turn duration, and queue records. The recorded monitor types no longer appear in its unsupported list.

The refreshed full Claude pass processed 1,593 files: 1,558 passed and the same 35 failed standalone identity/timing preflight. Across passing files it reconstructed 10 monitor identities, emitted 414,531 events, and retained 71,338 explicit gaps and 1,746 unavailable attachment representations in the resolver-free pass. Event and state-snapshot renderings were checked and hashed locally.

### Corpus rerun at the publication checkpoint (2026-09-11)

`node scripts/validate-native-replay.mjs` (reference reducer and terminal render; no publication, no model calls; aggregate counts only) ran against every local history with converters at `d0e2370`:

| Agent  | Files |    Passed | Rejected | Normalized events | Messages |   Tools |   Gaps | Unavailable artifacts |
| ------ | ----: | --------: | -------: | ----------------: | -------: | ------: | -----: | --------------------: |
| Codex  |   575 |       575 |        0 |           314,037 |   23,603 |  70,644 |  1,670 |                 1,981 |
| Claude | 1,684 |     1,649 |       35 |           444,720 |   47,091 | 103,161 | 78,799 |                 1,816 |
| Kimi   |   500 | 494 → 500 |    6 → 0 |           103,244 |   14,135 |  21,207 | 10,606 |                     7 |

The 35 Claude rejections are the previously classified histories without standalone session identity or timestamps. The run found a new Kimi 1.5 shape: 27 `tool.result` records in six files whose `output` is a single content-part object (inline `image/png` data URLs) rather than an array, which the converter rejected. Conversion now treats a single object as a one-element array; the image is reported as the same explicit `tool_result/image` gap as images inside array outputs, so output for previously converting histories is unchanged and the Kimi converter identity stays `kimi-history-4`. After the fix all 500 Kimi files pass (the Kimi row above is the rerun). Capturing tool-result images as attachments needs a future converter version. No OpenCode exports were present in the local inventory directory for this run.
