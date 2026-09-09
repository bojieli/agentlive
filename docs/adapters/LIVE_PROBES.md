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
