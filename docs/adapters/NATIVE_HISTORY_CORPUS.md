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
