# AgentLive

Broadcast and replay coding-agent sessions from one stable session URL, with structured messages, tools, file changes, and versioned attachments.

**Implementation is in progress.** This repository currently contains the implementation plan, live-agent transport probes, and tested recorder/publisher/playback foundations plus a programmatic HTTP/WebSocket server, shared synchronization engines, and immutable attachment storage. A workspace CLI can start the server, import recordings from all four agents, publish live sessions, and watch with a durable local cache. A standalone npm tarball includes an initial browser viewer; production viewer and release gates remain unfinished. See [implementation status](IMPLEMENTATION_STATUS.md) for verified work and remaining release gates.

## Development

Use **Node.js 26.8.1** and **pnpm 12.3.4**. Direct dependencies are pinned to the latest stable versions resolved when introduced; the lockfile makes installs reproducible.

```sh
npx --yes pnpm@12.3.4 install --frozen-lockfile
npx --yes pnpm@12.3.4 check
```

`check` verifies formatting, builds the TypeScript packages, and runs offline tests. It makes no model calls. CI runs the same command on macOS and Linux with Node 26.

## Local server and history import

After installing and building the workspace:

```sh
npx --yes pnpm@12.3.4 build
npx --yes pnpm@12.3.4 agentlive serve
```

The server listens on `127.0.0.1:7331` and persists state under `~/.agentlive`. First startup creates an owner-only credential file at `~/.agentlive/owner.json`; subsequent starts reuse it. The ready message reports the server URL. Stop with Ctrl-C or SIGTERM to close storage cleanly.

In another terminal, import a retained session:

```sh
npx --yes pnpm@12.3.4 agentlive import --agent codex --source /path/to/session.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent claude --source /path/to/session.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent kimi --source /path/to/session_ID/agents/main/wire.jsonl
npx --yes pnpm@12.3.4 agentlive import --agent opencode --source /path/to/opencode-export.json
```

Imports are private by default. Use `--visibility unlisted` or `--visibility public` to make a completed import readable without credentials. Import output includes the recording ID and conversion report; unsupported source objects remain visible in the report. Open the server URL in a browser and join using the recording ID. Private recordings require an access key; the owner secret in your local owner credential file can be used for viewing and listing. Keys stay in browser memory and are not included in share URLs.

Use `--state-dir` on both commands for isolated state, `--server` on imports for another server, and `--owner-file` for its credential JSON. An existing owner secret may instead be supplied through `AGENTLIVE_OWNER_SECRET`. Local artifact access defaults to the source directory; add explicit `--artifact-root` paths where needed. Moved Kimi exports require both `--native-session` and `--native-agent`. See `agentlive --help` for all options.

Inspect an imported recording in the terminal:

```sh
npx --yes pnpm@12.3.4 agentlive replay --stream <recording-id>
# For a public or unlisted recording on another server:
npx --yes pnpm@12.3.4 agentlive replay --stream <recording-id> --server https://example.test --anonymous
```

Replay downloads a fixed history boundary and prints timestamped messages, tools, file changes, attachment links, and capture gaps. Terminal control characters are escaped. By default it prints immediately. Add `--speed 2` for timing at twice the recorded speed, or `--interactive` for terminal controls: space pauses/resumes, `+`/`-` changes speed, and `q` quits. Timed replay starts at the first event and preserves subsequent recorded gaps. Add `--from-ms 30000` to reconstruct the state at 30 seconds and continue from there; all events at that timestamp are included in the state view. Positions beyond the fixed history boundary show its final state. It caps normalized events at 64 MiB; interactive backward/forward seeking, paged state, and interactive live playback remain unfinished. Private replay uses the same owner credential options as import.

These commands run from the source checkout. `pnpm package:build` also produces a standalone tarball with prebuilt browser assets. Automatic native-session discovery, production viewers, and the remaining release gates are tracked in the implementation status.

## Live integration probes

These commands use installed agents and their existing credentials in newly created synthetic workspaces. They may incur provider usage charges. Raw traces are saved locally under ignored `probe-results/`; never commit traces without reviewing and sanitizing them.

```sh
# Claude partial-message stream and Codex app-server stdio
node scripts/probe-agents.mjs claude codex

# Kimi's local server transcript subscription
node scripts/probe-servers.mjs kimi

# OpenCode's local SSE server, with an explicitly selected configured provider
AGENTLIVE_PROBE_MODEL=anthropic/claude-sonnet-5 \
  node scripts/probe-servers.mjs opencode
```

No upstream binaries are patched. The probes start only their own local servers and stop those processes afterward. The live probes create synthetic sessions; separate native-history scripts test explicitly selected existing histories read-only. Provider selection stays on the publisher machine; AgentLive's eventual broadcast server will not require model credentials.

## Architecture

- `packages/protocol`: versioned event validation, identifiers, errors, canonical JSON.
- `packages/storage`: checksummed append-only logs, frozen-prefix reads, atomic JSON replacement, kernel-owned file locks.
- `packages/publisher`: persistent native-session bindings, local capture journal, acknowledgments, recovery state, streaming known-secret redaction.
- `packages/server`: serialized session core, idempotent creation, publisher fencing, and lifecycle/history boundaries (network service in progress).
- `packages/playback`: deterministic reference reducer and independent playback clock.
- `tests/recovery`: restart, corruption, interrupted-write, process-death, and ownership tests.

Recordings use JSONL and immutable attachment files. Live delivery will use in-memory buffers with durable history fallback. A database is not required for the initial multi-session deployment.

The complete product contract and milestones are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

The real Codex capture-to-replay test also exercises a read-only tool and native app-server restart/resume:

```sh
npx --yes pnpm@12.3.4 build
node scripts/probe-codex-pipeline.mjs
```


Native history import is available through the four agent-specific programmatic import APIs and the workspace CLI. Its isolated local validation script imports an explicitly selected source file into a private test server and checks replay and retry identity:

```sh
npx --yes pnpm@12.3.4 build
node scripts/probe-history-import.mjs /path/to/codex-session.jsonl
```

The distributable npm package is not yet built. See [native-history corpus coverage](docs/adapters/NATIVE_HISTORY_CORPUS.md) for tested behavior and unresolved object/artifact types.

Follow a retained Codex JSONL history and publish subsequent appends:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent codex --source /path/to/session.jsonl
```

Start `serve` first using the same state directory. Publishing defaults to private visibility. Use `--record-format legacy` for older histories without structured item records. Stop with Ctrl-C and run the same command to resume the same recording; it stays open, and pending captured events remain on disk. The initial retained history is included. Source catch-up and remote delivery are separate states: `source-caught-up` reports local conversion, while publisher status reports network progress.

File following supports Codex, Claude Code, and Kimi Code; OpenCode uses its native server as described below. Initial recording creation needs connectivity; an existing binding can capture text while disconnected. Attachment upload can pause conversion until connectivity returns. Compatible ended imports can continue live with `--resume-import` and their original import options.

A read-only native transport/restart probe is available:

```sh
node scripts/probe-codex-publish.mjs /path/to/archived-session.jsonl
```

Watch a recording with automatic history catch-up and reconnect:

```sh
npx --yes pnpm@12.3.4 agentlive watch --stream <recording-id>
```

Use `--anonymous` for recordings that permit anonymous reads, or the existing owner credential options for private recordings. The local subscriber cache stores checksummed JSONL under `<state-dir>/subscriber`; it contains received recording content, but does not store the connection credential. Restarting displays the cached prefix and then reconnects from its durable receipt cursor. Cached history can render while the server is offline. Reconnection never silently switches to a different recording revision.

This is the terminal reference viewer: completed messages, tools, and supported state updates render as they arrive. Use `--interactive` to pause/resume presentation with space or quit with q. Receipt continues into the durable cache while presentation is paused or awaiting an asynchronous output sink. On resume, presentation reads the cached backlog in order. Add `--resume-view` to save presentation progress and reconstruct that position on the next launch. Use `--restart-view` to reset presentation to the beginning while keeping the receipt cache. These two options are mutually exclusive; without either, watch displays history from the beginning. Token-by-token presentation, live timeline seeking/speed controls, and paged state remain unfinished. It currently enforces a 64 MiB event budget for in-memory playback and a separate 512 MiB durable cache limit. Cache reconstruction replays history from the beginning; storage pagination and snapshots remain in the plan.

Claude Code uses the same durable publication path:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent claude --source /path/to/session.jsonl
```

It backfills retained messages and tool state, then follows complete appended records. Partial trailing writes remain deferred until the next append. Restarting reconstructs tool state before processing new results. Native inline images/documents use the existing attachment spool; unsupported native objects retain explicit capture gaps. This single-file adapter does not yet merge parent/subagent files or expose token deltas absent from the native history.

Run an explicit integration test against the installed Claude CLI (creates a new synthetic session and resumes it through the native CLI):

```sh
node scripts/probe-claude-publish.mjs
```

Kimi Code can publish one retained agent wire log:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent kimi \
  --source /path/to/session_ID/agents/main/wire.jsonl
```

The adapter derives native identity from the session directory. For a moved wire file, provide both `--native-session <id>` and `--native-agent <name>`. Goals, tasks, recorded interactions, and plans share the same stateful conversion used by historical import. A binding currently follows one agent file; combining the main agent and subagent files remains unfinished.

The installed Kimi CLI integration test creates a synthetic session, discovers it through `kimi session list`, resumes it natively while publishing, and checks publisher restart:

```sh
node scripts/probe-kimi-publish.mjs
```

Continue an imported session as a live recording:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent claude \
  --source /path/to/session.jsonl --resume-import
```

Use the same state directory, server, source prefix, filtering policy, title, visibility, and artifact settings as the import. With `--resume-import`, the default title matches the import command's default. For Codex, select the same structured/legacy format as the imported prefix. The transition preserves the recording ID, producer sequence, and existing attachment identities. Its durable intent and idempotent reopen operation allow retrying the same command after a lost response or process restart.

The import must already be fully uploaded and ended. Changed converters or filtering policies still require a separate migration. Continuing an OpenCode historical import remains pending snapshot-converter migration. Once the transition starts, the import command rejects that binding to avoid ending a recording being continued live.

Publish an existing OpenCode session through its native headless server:

```sh
# Start OpenCode with your configured provider and existing server credentials.
opencode serve --pure --hostname 127.0.0.1 --port 4096

# In another terminal, attach AgentLive to the native session.
npx --yes pnpm@12.3.4 agentlive publish --agent opencode \
  --native-server http://127.0.0.1:4096 --native-session <session-id>
```

Use `OPENCODE_SERVER_PASSWORD` (and `OPENCODE_SERVER_USERNAME` when configured) in the publisher's environment for native server authentication. `--server` selects the AgentLive destination separately. Initial attachment validates native identity/authentication before creating the remote recording. Repeat the command to resume the same publisher binding; native-server reconnect and AgentLive-server reconnect run independently. An existing binding keeps capturing available native snapshots while AgentLive is offline, then sends its durable backlog.

OpenCode publishing currently preserves observed snapshots, not every native text delta. It captures base64 data-URL files and tool attachments; local `file:` references require explicit `--artifact-root` access. Remote authenticated artifact URLs, import continuation, source removal/reopen presentation, and scalable snapshot state remain unfinished. The installed-agent integration test covers three native turns, native server restart, a turn while publication is detached, and deduplicated publisher restart:

```sh
node scripts/probe-opencode-publish.mjs
```

OpenCode local artifact access is disabled by default. Allow a directory explicitly when its native references point to files available on this machine:

```sh
npx --yes pnpm@12.3.4 agentlive publish --agent opencode \
  --native-server http://127.0.0.1:4096 --native-session <session-id> \
  --artifact-root /path/to/allowed/artifacts
```

Inline files retain their embedded bytes; local files without a recorded original hash are labeled as current-file copies. Text artifacts are filtered before storage. Upload completes before an available attachment/link event is published, and retries reuse immutable captured bytes even if the original file disappears. Raw data URLs are not copied into broadcast reference events. Returning to a previously captured file version reuses that version's reference without announcing it twice.

Historical OpenCode imports use converter version `opencode-export-2` for the same file and tool-attachment support. Existing imports pinned to the older converter still require migration or a separate publisher state directory.


For multi-session hosting, `serve --max-cached-sessions 128` sets the resident session cache capacity. Active requests and live connections retain their sessions; idle sessions can be evicted and reopened from JSONL. If every cached session is in use, new session loads receive a retryable capacity response. This limits resident session count, not total memory or retained disk usage. Programmatic `RecordingStore.get/create` calls acquire ownership and must be paired with `store.release(session)` when finished.


Server shutdown stops admission and drains accepted work. Configure its waiting deadline with `agentlive serve --shutdown-timeout-ms 30000` (default: 30 seconds; positive integer up to 2147483647). If the deadline expires, the CLI reports an error and cleanup continues while retaining the store lock. The library’s `close()` rejects with `ShutdownTimeoutError` (`code: "shutdown_timeout"`); use `whenClosed()` to await actual completion afterward. A timeout does not prove a pending write was canceled. Use a process supervisor for a hard termination deadline, including blocked event loops. On restart, publishers reconcile durable acknowledgements and retry unacknowledged events through the existing deduplication protocol.


Watch cancellation has a configurable 30-second deadline: `agentlive watch --stream <id> --cancellation-timeout-ms 5000` limits the caller’s wait after cancellation to five seconds. If accepted cache work is still pending, the watcher reports `CancellationTimeoutError` and retains the cache lock until cleanup drains. Library callers can await `error.whenDrained` for eventual completion or failure. This combines responsive cancellation with exclusive cache ownership; it does not force-cancel disk I/O. A blocked JavaScript event loop can delay the deadline.

To watch with recorded timing, use `agentlive watch --stream <id> --speed 1 --interactive`. Space pauses presentation, +/- changes speed, `l` resumes immediate live catch-up, and `q` exits. Receipt continues while playback is paused or slowed. Without `--speed`, watch catches up immediately. Catch-up preserves every event in order; it does not discard intervening history. `--resume-view` also restores the timing anchor at the saved presentation position.


New OpenCode snapshot imports can continue in the same shared recording:

```sh
agentlive import --agent opencode --source session-export.json --title "My session"
agentlive publish --agent opencode --native-server http://127.0.0.1:4096 --native-session <native-session-id> --source session-export.json --resume-import --title "My session"
```

Use the same state directory, target server, title, visibility, filtering secrets, and artifact settings. Retain the original export unchanged. After the first successful transition, publishing can restart with the same arguments; `--resume-import` is then optional, but `--source` remains required to verify the imported prefix. Native authentication secrets must already be included in the import’s filtering policy if they add to that policy. The importer now uses converter `opencode-snapshot-4`; earlier export converters still require migration before continuation.


With `watch --resume-view`, playback speed, pause state, and timed/live catch-up mode are saved separately from the event cache and viewing position. Interactive restart shows the saved snapshot even when paused. Noninteractive restart resumes unpaused; an explicit `--speed` overrides saved speed and selects timed playback. `--restart-view` resets both viewing position and playback preferences. Ordinary watch without either flag does not restore or update these preferences.


Start a live viewer at a particular recorded time with `agentlive watch --stream <id> --from-ms 30000 --speed 1 --interactive`. The viewer fetches a fixed server history boundary, receives that prefix, displays its state at 30 seconds, then continues with the remaining and newly arriving events. A position beyond the boundary clamps to its latest event. Explicit `--from-ms` overrides a saved viewing position; with `--resume-view`, the selected event position is saved after its snapshot is displayed. Seeking requires the server for the initial boundary, and state reconstruction still uses the terminal viewer’s 64 MiB budget.


During interactive watch, `[` seeks back 30 seconds, `]` seeks forward 30 seconds, and `0` returns to the beginning. These controls pause presentation for inspection; space resumes and `l` catches up live. Seeking uses the currently received cache, so it also works during a network outage once history is cached. Programmatic viewers can call `PlaybackPacer.seek(milliseconds)` for an exact target and observe completion through `onPositioned`. Programmatic seeking preserves the controller’s pause state. Requests beyond received history clamp to its latest event.


Saved viewer positions retain an explicit seek time between events. For example, seeking to 30 seconds between events at 0 and 60 seconds and restarting with `--resume-view` restores the 30-second snapshot and timing anchor. Older sequence-only checkpoints still load at their event timestamp. This preserves selected seek positions; continuously elapsed playback time between events is not checkpointed on every clock tick.


Discover recordings hosted by your server with `agentlive list --server http://127.0.0.1:7331`. The command uses your owner credential and returns a JSON page with recording summaries and `nextAfter`. Continue with `--after <nextAfter>`; `--limit` accepts 1–100 and defaults to 50. Publisher credentials and anonymous access cannot list the server’s recordings. Pages are ordered by recording ID, and refreshing from the first page discovers recordings added before your current cursor.


Build and verify a standalone installation with Node 26:

```sh
npx --yes pnpm@12.3.4 package:verify
npm install --global ./dist/release/agentlive-cli-0.1.0.tgz
agentlive --help
```

The build bundles AgentLive workspace code into one CLI and includes a shrinkwrap for its external runtime dependencies. Verification installs the tarball in a fresh temporary directory with install scripts disabled, starts its server, imports a recording, lists and replays it, retries the import, and checks shutdown. `node scripts/probe-claude-publish.mjs --package` additionally creates and resumes a real Claude session, then verifies its recording through the installed package. These are local private build artifacts; no npm release has been published. Browser assets and public-release packaging are still in development.


Package builds use the reviewed dependency tree in `packaging/runtime-lock.json` and do not resolve new runtime versions. After intentionally changing runtime dependencies, run `npx --yes pnpm@12.3.4 package:lock` and review the lock diff. `package:verify` rebuilds with an unreachable registry and requires byte-identical tarballs before testing installation. Installing external dependencies still requires registry access or an existing npm cache.


## Browser viewer

The server root serves the React viewer on the same origin as recording APIs. Join or leave a recording, browse an owner-authorized page of sessions, pause while receipt continues, seek with the timeline, select playback speed, or follow incoming events. Messages, tools, file changes, and versioned attachments appear in first-event order. Agents, tasks, goals, recorded approvals/questions, plans, and monitors have structured cards with status and ownership. Related agents/tools link within the recording, and captured plan files open through the attachment inspector. Recorded decisions are passive history; raw event fields remain available under Recorded data. Open an attachment version in the inspector to preview supported content or download the verified file. Loading uses the joined session's credential, the exact announced size, a 25 MiB limit, and SHA-256 verification. Plain UTF-8 text (including HTML/SVG source) is displayed as text up to 1 MiB. Static PNG previews require bounded dimensions and chunk structure; animation and compressed ancillary metadata are excluded. Other files remain downloadable. Closing the inspector cancels loading and releases its object URLs.

The browser receipt buffer is bounded to 64 MiB of encoded events. With Save history enabled at join, an evictable IndexedDB cache saves validated history batches and their cursor atomically. Reload authenticates first, verifies the saved hash chain, and downloads the missing suffix. The cache holds at most eight recordings and 256 MiB of encoded history per site. Storage failure or a competing tab falls back to memory; Clear saved histories removes local copies without deleting server recordings. Access keys and attachments are not stored in this cache. Hidden pages suspend receipt; returning to the foreground revalidates the subscription and catches up without moving a paused view. Timed playback excludes hidden time and unobserved tick gaps over two seconds. Paged state, rich artifact previews, and actual desktop/mobile storage, lifecycle, and visual verification remain release work. The memory quota covers encoded events rather than total JavaScript/DOM overhead.

When Save history is enabled, the browser also saves the exact presented event, selected timeline position, speed, and paused/playing/follow mode. Rejoining restores that view from a verified history prefix while receipt catches up separately. A paused view does not reveal later events with the same timestamp. Control changes schedule an immediate save; moving playback checkpoints are coalesced to once per second, with a final flush on leave and a best-effort flush when hidden. Abrupt browser termination may lose recent unsaved view changes. Preferences are local to this browser profile and recording revision; the last preference transaction wins across tabs, without changing another tab’s current view. Clearing saved histories removes these preferences too.

The activity feed uses a measured scrolling window, so offscreen cards are unmounted. Tool/edit and Recorded data expansion choices survive scrolling within the joined viewer. First/Latest controls and arrow/Home/End keys navigate items, and ordinary agent/tool links reveal their destination before focusing it. While following live, the feed stays at the end only if you are already within 48 pixels of it. The full event/reducer state is still bounded in memory rather than paged; native browser find cannot search unmounted cards, and expansion choices are not yet saved across leave/reload. Real desktop/mobile scrolling and accessibility validation remain release gates.

Use Search in the activity feed to find case-sensitive literal text across visible objects at the selected playback position, including offscreen messages, tool input/output, edits, workflow fields, attachment metadata, and capture notes. Search pauses presentation while receipt continues. Results include short excerpts and come in pages of at most 50 matching objects; selecting one reveals and focuses its card. Changing the playback position invalidates old results. Search does not download attachment contents or inspect future/hidden objects, and ordinary browser Find still only sees mounted content.

Long message/tool/diff text and recorded-data blocks now have text-page controls, keeping one bounded page per field in the DOM. First/Previous/Next access the full text; Follow latest text keeps the last page visible as it grows and can be toggled off. Manual page choices survive virtual scrolling within the joined viewer. Search selection opens the page containing the beginning of its match in applicable text fields. This reduces rendered text size; full transcript strings still reside in memory, and page choices are not yet saved across leave/reload.
