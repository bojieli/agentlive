# Live-agent transport evidence

Date: 2026-09-09. Runtime: Node 26.8.1 on macOS arm64. The initial transport prompts ran in new synthetic temporary directories and requested short explanatory responses without tools. A later Codex pipeline test exercised a read-only tool and native-session resume, as recorded below. These checks establish live transport feasibility, not the complete adapter compatibility matrix.

| Agent | Version tested | Successful transport | Observed evidence |
| --- | --- | --- | --- |
| Claude Code | 2.1.266 | `--print --output-format stream-json --verbose --include-partial-messages` | 189 `text_delta` events, assistant output marker, successful result. Installed CLI updated through its official updater from 2.1.263. |
| Codex | 0.153.4 | `app-server --stdio`, initialize → thread/start → turn/start | 118 `item/agentMessage/delta` notifications and `turn/completed`; the final assistant item contains the probe marker. Installed CLI matches the latest npm version checked. |
| Kimi Code | 0.41.0 | `kimi web`, REST create/profile/prompt, WebSocket `subscribe_v2` with delta grade | 320 transcript-op frames, including 301 `append` operations; completed turn and generated artifact/text-frame marker. Official updater reports this version current. |
| OpenCode | 1.18.30 | `opencode serve`, `/event` SSE plus `/session/:id/message` | 14 message-part deltas, generated assistant marker, no session error. Tested latest npm package via `npm exec`; Homebrew currently provides 1.18.29. |

OpenCode's successful probe used `anthropic/claude-sonnet-5` with an already available credential. Claude, Codex, and Kimi used existing configured authentication. No model credentials were committed or sent to an AgentLive server.

## Findings that changed the implementation

- Kimi prompt-mode `stream-json` returned one completed assistant block in the initial probe. Its server transcript subscription is the live capture path being evaluated.
- Kimi session creation accepts `agent_config` but does not apply its model field in the tested server. Call the documented session profile endpoint to select the configured model before submitting a prompt.
- Kimi transcript event envelope `seq` can repeat while `payload.seq` advances; recovery must use the per-agent transcript sequence defined by that surface.
- OpenCode's default DeepSeek provider returned HTTP 402, “Insufficient Balance.” An alternate configured provider worked.
- OpenCode's Google SDK expected `GOOGLE_GENERATIVE_AI_API_KEY`, while this shell exposes `GEMINI_API_KEY`. A separate direct Gemini check also reported that the request location was unsupported; Gemini was not used for the successful run.
- A Krill credential and an existing local Krill provider endpoint were found without displaying credential values. No Krill model request was necessary after the Anthropic test succeeded.
- Early server probes mistakenly searched for a success marker in the entire event stream, including the submitted prompt. Those summaries were corrected locally. The probe now checks agent completion/failure and generated assistant/frame content; raw historical false-positive runs are not claimed as evidence.

## Interfaces used

- [Claude programmatic streaming](https://code.claude.com/docs/en/headless#stream-responses)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server); generated installed-version TypeScript schemas into temporary local storage for inspection.
- [Kimi server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.md), especially session profile and transcript subscriptions.
- [OpenCode server API](https://opencode.ai/docs/server/), including instance-scoped SSE and session messages.

Raw traces are ignored under `probe-results/`. Do not check in startup logs, which may contain local-server access tokens. Production adapters must select and filter broadcast fields rather than forwarding raw vendor envelopes.

Next tests: native-session resume in a new process, subscriber reattachment during an active turn, long command output, file edits/failure/approval/cancellation, upload/generated-image capture, multi-file artifact resolution, and source-history reconciliation after missed deltas.


## Codex capture/publish/replay and native resume

Command: `npx --yes pnpm@12.3.4 build && node scripts/probe-codex-pipeline.mjs`.

The latest successful run used a synthetic README, the installed Codex app-server, `CodexCapture`, the durable publisher journal/network pump, the HTTP/WebSocket server, `SubscriberClient`, and the reference reducer. It observed 100 assistant text deltas, three assistant messages, one completed read-only shell tool, 122 producer events, and 123 stored server events. The tool output contained the expected fixture text. Both requested markers were checked in completed assistant output. No command-output delta notifications occurred in this run, so it proves final tool-output capture, not incremental shell-output fidelity.

After the first turn, the probe closed the owned app-server, started a new process, resumed the same native thread, and paged completed turns using `thread/turns/list` with full item detail. Recovering those snapshots did not advance the producer sequence or duplicate captured history. A second turn published into the same recording. Live messages/tools matched a fresh replay from the committed JSONL, and the tested run contained no capture gaps.

This is a bounded two-turn test. It does not prove active-turn crash recovery, full source-history pagination for very large turns, native-TUI attachment, file modification/approval/cancellation, subagent capture, or artifact rewriting. Those remain acceptance requirements. The probe owns and closes its own processes and writes only synthetic temporary workspaces; it does not operate on the user's existing coding sessions.

Claude file-follow/native-resume probe (2026-09-09): `node scripts/probe-claude-publish.mjs` starts a fresh synthetic Claude session with tools disabled, locates its native JSONL, backfills it through the real publisher/server, then resumes the same native session with the standard Claude CLI while file following remains active. It waits for the final source cursor and remote producer prefix, stops/restarts the publisher, and verifies no added duplicate events. Two successful runs each produced 26 stored events from two native turns. No upstream modification or private source session was needed. The script emits only aggregate success data; the native synthetic transcript remains local.

Kimi file-follow/native-resume probe (2026-09-09): `node scripts/probe-kimi-publish.mjs` runs two synthetic native Kimi turns, discovers the new session with the supported `kimi session list --cwd ... --json` interface, and resumes it using `--session`. Publishing starts after the first retained turn and remains active during the second. The probe waits for the source and remote producer boundaries, then restarts the publisher and checks event-count stability. The successful run produced 36 stored events. Workspace paths are canonicalized because Kimi indexes macOS workspaces by their resolved path. The earlier alias lookup failure was a probe discovery issue; the native first turn had completed successfully.

Claude import-to-live extension (2026-09-09): `node scripts/probe-claude-publish.mjs --resume-import` imports the initial native turn as an ended private recording, explicitly reopens that binding, resumes the original Claude session while publishing, and verifies source/producer catch-up and publisher restart. The successful run retained 28 stored events, including the end/reopen lifecycle pair, with both native turns preserved. This complements injected lost-reopen-response tests and the cross-process CLI transition test.

OpenCode observer integration (2026-09-09): `AGENTLIVE_PROBE_MODEL=anthropic/claude-sonnet-5 node scripts/probe-servers.mjs opencode` now runs the production native observer alongside the existing raw SSE probe. The installed headless server completed the synthetic turn; 19 validated snapshots included the completed assistant response and the SSE stream contained 14 text-part deltas. The observer begins with the empty session history before prompting. Raw synthetic events remain under ignored private probe output. This proves native observation, not yet normalized live publication or OpenCode import-to-live continuation.

OpenCode capture-to-server extension (2026-09-09): the native server probe now binds a private AgentLive recording, converts observed snapshots with `OpenCodeCapture`, publishes durable events, and reconstructs playback from the server log. After native completion it closes/reopens capture, accepts the current native snapshot again, and verifies unchanged producer event count. The successful run using `anthropic/claude-sonnet-5` produced 17 snapshots, 10 stored events, and a completed assistant marker in replay. The source stream also had 13 delta notifications; snapshot conversion does not claim to preserve every delta notification.

OpenCode publishing/native-resume probe (2026-09-09): `node scripts/probe-opencode-publish.mjs` starts the installed native headless server in a new synthetic workspace and uses supported session/message APIs. It publishes retained first-turn history, restarts the native server and continues the same session, detaches publishing for another native turn, then reattaches and checks a further deduplicated restart. The successful run used the available `anthropic/claude-sonnet-5` provider and retained 22 stored events from three native turns. Output contains aggregate results only. Programmatic publisher recovery and a real CLI process are additionally covered by offline integration tests.

OpenCode attachment extension (2026-09-09): the three-turn `probe-opencode-publish.mjs` now supplies a synthetic text attachment through the native message API and verifies the filtered file downloaded from AgentLive after native/server and publisher restart. The successful run retained 24 stored events and one downloadable attachment. A separate official-CLI export of that native session passed private historical import, rendering, attachment hash/download verification and retry identity with 32 stored events. Workspace-scoped native export discovery expanded the local OpenCode corpus to 12 files; all passed normalized replay/render validation.


## Browser playback checkpoint recovery

The shared native probe verifier now saves a paused midpoint and playback speed, closes the browser model, and reopens it against the same recording. It compares the exact reconstructed reducer state, timeline position, receipt count, speed, and pause/follow mode. It also checks seeking and foreground revalidation. IndexedDB is supplied by a test double; this does not validate real browser disk persistence or rendered UI behavior.

On 2026-09-09, OpenCode `--resume-import` passed with three native turns, 26 stored events, six messages, and one verified attachment, including native-server restart, detached-history recovery, publisher deduplication, and paused playback restoration. Claude `--resume-import` passed with two native turns, 28 stored events, and four messages, including imported history, native resume, live suffix capture, publisher deduplication, and paused playback restoration. Raw native transcripts and credentials are excluded from repository evidence.


## Windowed activity renderer validation

On 2026-09-09, the native Codex app-server probe passed a fresh session with a read-only tool and native restart/resume: 134 server events, five messages, one tool, six activity cards, no reported capture gaps, matching replay, and no duplicate resumed history. The shared verifier now renders the exact production ActivityCard component for each visible final-state object and retains only its aggregate markup hash/count, alongside the existing browser-model seek, cache, and foreground checks.

The read-only local corpus sweep exercised the new production activity cards, including messages, tools, edits, attachments, workflow objects, and capture notes:

| Source | Files passed / examined | Canonical events | Activity cards rendered | Capture gaps | Unavailable artifacts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex | 524 / 524 | 276,949 | 107,137 | 1,533 | 1,501 |
| Claude | 1,563 / 1,598 | 414,656 | 215,258 | 71,398 | 1,746 |
| Kimi Code | 461 / 461 | 98,151 | 44,020 | 9,697 | 7 |
| OpenCode retained exports | 12 / 12 | 129 | 30 | 0 | 1 |

All 35 failures were `Claude source lacks session identity or timestamp`, matching the previously observed category. Counts describe the examined corpus at the time of the run; live histories may subsequently grow. Capture gaps and unavailable artifacts remain explicit fidelity limitations. Aggregate results are local ignored probe artifacts; raw source content and generated markup are not committed. These checks validate data reduction and card markup, not actual browser layout, virtual scrolling, focus, accessibility, or mobile lifecycle behavior.


## Activity search on a native session

On 2026-09-09, a fresh two-turn Kimi Code probe passed with 35 stored events, seven messages, and 19 activity cards. The shared verifier found an actual captured message using the production snapshot-search API, retaining only a success flag and aggregate counts/hash. Native resume, full-history backfill, live suffix capture, publisher restart deduplication, and browser-model playback restoration also passed. This verifies search data flow, not rendered browser search interaction or complete upstream capture fidelity.
