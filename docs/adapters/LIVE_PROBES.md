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


## Bounded text-page rendering

On 2026-09-09, the native Codex probe passed with 117 stored events, five messages, one tool, six activity cards, and no reported capture gaps. Native restart/resume, deduplication, replay equivalence, activity search, and browser-model playback restoration passed using the updated production card renderer.

The read-only corpus sweep with bounded text-page markup passed 527/527 Codex files (107,327 cards), 1,563/1,598 Claude files (215,258 cards), 462/462 Kimi files (44,039 cards), and 12/12 retained OpenCode exports (30 cards). The 35 Claude failures again lacked source session identity or timestamps. These totals cover initial rendered pages and their navigation markup; separate exact-reassembly tests establish that page boundaries preserve the complete input text. They do not establish real-browser control behavior, search-to-page scrolling, overall browser memory use, or complete capture fidelity. Raw histories and generated markup remain excluded from repository evidence.


## Native text-store recovery

On 2026-09-09, OpenCode `--resume-import` passed three native turns with 26 stored events, six messages, and one verified attachment. The shared verifier persisted six filtered text fields (814 UTF-16 units), closed and reopened the new TextStore, and compared bounded reads with the captured text; encoded storage was 1,657 bytes. Native-server restart, detached history, publisher deduplication, imported-history continuation, attachment verification, and browser-model playback/search checks also passed. Temporary content files were removed, and the result contains counts rather than text. This is storage-layer integration evidence; the production viewer still uses its existing in-memory reducer.


## Native paged snapshot recovery

On 2026-09-09, Claude `--resume-import` passed with two native turns, 28 stored events, four messages, and 16 rendered activity items. The shared content verifier wrote a paged snapshot, closed and reopened TextStore, and compared restored state with the native recording's reference-reducer state. The final rerun used strict deep equality, including Map and undefined-field semantics. Four text fields contained 468 UTF-16 units; combined content and snapshot storage used 12,272 bytes. Imported-history backfill, native resume, live suffix capture, publisher restart deduplication, search, seek, foreground revalidation, and paused playback restoration also passed.

Only aggregate results are retained in documentation; temporary stored content is removed by the verifier. This establishes snapshot storage equivalence for the exercised native session. The browser model still receives and reduces events through its existing path; it does not yet load production snapshots, and this probe does not establish real-browser behavior or long-session memory bounds.


## Server snapshot publication and HTTP reconstruction

On 2026-09-09, a fresh Claude `--resume-import` probe passed two native turns, 28 stored events, four messages, and 16 rendered activity items. The shared verifier requested production server snapshot publication at sequence 28, selected the same descriptor, and reconstructed it through 32 bounded HTTP content reads. Strict deep equality matched the native session's reference state. Import backfill, native resume, live suffix, publisher deduplication, search, seeking and paused browser-model restoration also passed.

This exercises the server endpoints with the native recording's credential, not an in-process snapshot shortcut. The verifier reports only the selected sequence, read count and success flag. The production browser still follows its existing event-based reducer; paged viewer loading, real browser behavior, and long-session performance remain unverified.

The standalone package verifier additionally installs the actual tarball outside the workspace, imports a synthetic recording, publishes/selects its snapshot, and reads the root manifest through the installed server. The successful run also verifies reproducible rebuilding, disabled install scripts, CLI replay, import retry identity, browser assets, and clean shutdown.


## Shared snapshot client on a native recording

On 2026-09-09, Claude `--resume-import` passed again with two native turns, 28 stored events, four messages and 16 rendered activity items. The server-snapshot verifier now uses `RecordingSnapshotClient` for publication, selection and lazy content reads. It made 34 bounded content requests (including root validation for both publication and selection) and reconstructed state with strict equality to reference replay. History backfill, native resume, live suffix capture, publisher deduplication and browser-model restoration passed. Only aggregate results are reported. The probe exercises the shared production transport, not automatic snapshot use by the browser UI.


After the UTF-16 range validation fix, a fresh Kimi Code probe passed two native turns with 35 stored events, seven messages and 19 rendered activity items. The shared snapshot client reconstructed the server snapshot through 39 bounded content requests and matched the native reference state strictly. Native resume, history backfill, live suffix capture, publisher deduplication, activity search and browser-model restoration passed. This adds a second native-agent integration to the shared-client evidence without retaining its text.


## Persistent key index on native content

On 2026-09-09, OpenCode `--resume-import` passed three native turns with 26 stored events, six messages and one verified attachment. The shared content verifier bulk-built an immutable key index for six captured text references, closed and reopened TextStore, and verified each lookup before comparing its bounded text reads. Text fields contained 824 UTF-16 units; combined text, snapshot and index storage used 12,537 bytes. The production snapshot client also reconstructed the recording through 28 content reads and matched reference state.

Native-server restart, detached history recovery, publisher restart deduplication, live converter migration, imported-session continuation, attachment checks, seeking and browser-model restoration passed. Only aggregate evidence is retained. This checks the index against native content in a private temporary store; production reduction and snapshot metadata do not yet use the new index.


## Incremental text references on a native recording

On 2026-09-09, the Codex app-server probe passed with native restart/resume, 106 server events, five messages, one tool and no reported capture gaps. The shared content verifier wrote seven text fields as prefix-plus-append, compared each reference with a complete write, reopened storage and verified indexed bounded reads. The fields contained 765 UTF-16 units; combined text, snapshot and index storage used 11,708 bytes. Snapshot reconstruction through the shared client used 24 content reads and matched reference replay. Search, seek, foreground revalidation, persisted playback restoration and resume deduplication passed. Only aggregate evidence is recorded; production event reduction does not yet use incremental TextStore appends.

The preceding index commit's macOS CI exposed a nondeterministic OpenCode test fixture: its error message lacked a native completion timestamp, so the live redactor correctly held the final `d` when the generated credential began with that character. The terminal-history fixture now includes completion, and deterministic capture coverage verifies both withholding for active text and release at native completion. This changes test evidence, not the privacy policy. Explicit finalization of genuinely unfinished frozen imports remains tracked work.


## Persistent map order on native content

On 2026-09-09, Kimi Code passed two native turns with 35 stored events, seven messages and 19 rendered activity items. The shared content verifier stored seven incrementally written text references in OrderedContentMap under numeric keys, reopened TextStore and checked ordered ranges against the original field sequence. The fields contained 1,762 UTF-16 units; combined text, snapshot, index and historical map-node storage used 32,307 bytes. Shared-client snapshot reconstruction, native resume, full-history backfill, live suffix capture, publisher deduplication, search and browser-model restoration passed.

Only aggregate evidence is recorded. This verifies the map primitive with native text references; production event reduction and viewer snapshot loading do not yet use it.

## Paged event reduction and checkpoint recovery

On 2026-09-09, the shared native verifier began applying captured events through PagedReducer in a private temporary TextStore. It closes and reopens storage at a midpoint checkpoint, continues event reduction and compares the resulting state strictly with reference replay. Kimi Code passed with 35 events, seven messages and 19 activity items; paged state/content used 88,716 bytes. Codex passed with 114 events, five messages, one tool and no capture gaps; paged state/content used 240,974 bytes. Native resume, publisher deduplication and the existing browser-model/shared snapshot checks also passed. These are library integration checks, not production paged viewer adoption.

The retained-history validator now supports `--paged`. All 12 retained OpenCode exports passed, covering 129 canonical events and 29 messages, including checkpoint reopen and strict equivalence. One unavailable artifact remains explicitly represented. This is a subset of the larger reference-only local-history corpus; it does not establish all-agent paged corpus coverage. Temporary native content is removed; only aggregate evidence is retained.

After long-reference indexing and artifact descriptor validation were tightened, the full local check passed 297 tests in 39 files and standalone package verification passed. A fresh live Codex probe passed with 109 events, five messages, one tool and no gaps; paged reduction used 229,866 bytes and matched reference state after checkpoint reopen. Native restart/resume and deduplication passed. The 12-file OpenCode paged corpus also passed again.


## Production paged server snapshots

On 2026-09-09, a live Kimi Code run passed after server snapshot publication switched to paged event reduction. Two native turns produced 35 stored events, seven messages and 19 activity items. The shared client loaded the explicitly tagged paged checkpoint through 69 content requests and reconstructed state equal to reference replay. Native resume, full-history backfill, live suffix capture, publisher restart deduplication, search and browser-model restoration passed. The separate paged reducer verifier also passed checkpoint reopen with 88,785 bytes of stored state/content.

Standalone package verification passed with the paged snapshot manifest, isolated installation, reproducible rebuild, publication/selection, history import/replay and clean shutdown. Browser/terminal automatic paged seeking remains unfinished; this establishes the production server and shared transport path.

The final isolated full check passed 299 tests in 40 files. An earlier run concurrent with package/native disk work timed out the existing 60-second large snapshot-map test and encountered cleanup while its work was still running; the isolated rerun passed without changing test workload or deadline. Migration coverage includes legacy catalogs, suffix-only rebuild after restart, failed-build catalog preservation and explicit format/boundary rejection.

## Reopened browser snapshot range cache

On 2026-09-10, a live Kimi Code run passed with 35 stored events, seven messages and 19 activity items. The shared production snapshot client used BrowserSnapshotCache with fake IndexedDB, made 51 initial content requests, closed/reopened the cache and reconstructed the same state with zero additional content requests. Selection still contacted the server. Native resume, history backfill, live suffix capture, deduplication and the existing browser-model checks passed. Only aggregate results are retained.

The full suite passed 304 tests in 41 files. A tightened revision-isolation test also passed with equal-length revision IDs and otherwise matching range identities. Standalone installation/reproducible rebuild and snapshot publication passed. This verifies optional range persistence through the shared client; actual browser/device behavior and automatic paged viewer reconstruction remain required.

## Writable browser content and shared codec

On 2026-09-10, a live Codex app-server run passed with 108 stored events, five messages, one tool and no reported capture gaps. The verifier applied each event through paged reducers backed by filesystem TextStore and BrowserContentStore using fake IndexedDB. Midpoint checkpoints had identical content references. Both stores were closed/reopened, reduction continued and final state matched reference replay. Filesystem paged state/content used 226,413 bytes.

Native restart/resume, deduplication, browser-model restoration, search and seeking passed. The shared snapshot range cache also reopened and reconstructed the recording with zero additional content requests. Full local validation passed 308 tests in 42 files, including filesystem crash/corruption/ownership tests after codec extraction, and standalone package verification passed. This establishes the shared codec and writable browser backend; automatic paged browser working-state publication and actual device validation remain unfinished.


## Recovery from the browser's published state pointer

On 2026-09-10, Claude `--resume-import` passed two native turns with 28 stored events, four messages and 16 activity items. The verifier used BrowserPagedState to apply/publish each event, closed it at the midpoint, and reopened by discovering the persisted checkpoint pointer. The midpoint reference matched the filesystem checkpoint, and final state matched reference replay. Import continuation, native resume, full-history backfill, live suffix capture and deduplication passed. The snapshot range cache reopened with zero additional content reads.

The full suite passed 312 tests in 43 files. A subsequent focused suite passed five tests, including a new cancellation injected during the IndexedDB root-write transaction; reopening retained the previous checkpoint. Standalone installation/reproducible build also passed. BrowserSession receipt and viewport integration remain separate work.


## Stored text pages through the renderer's range reader

On 2026-09-10, OpenCode `--resume-import` passed three native turns with 26 stored events, six messages and one verified attachment. After recovering persisted browser state, the verifier read first/latest pages of all six text fields through readTextPage, the same bounded reader used by source-backed PagedText, and compared them with reference string paging. Checkpoint identity, native-server restart, detached history recovery, import continuation and publisher deduplication also passed. The reopened snapshot range cache needed no additional content requests.

Full local validation passed 317 tests in 44 files and package verification passed. Browser runtime discovery was retried using its documented recovery flow and returned no connected browsers. Actual React interaction/loading/focus behavior remains unverified; native data-path parity does not establish those checks or complete BrowserSession migration.
