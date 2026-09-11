# AgentLive usage guide

Detailed behavior of the shipped commands. See the [README](../README.md) for a quick start and [compatibility](compatibility.md) for per-agent capture fidelity. Commands below use the installed `agentlive` binary; from a source checkout run `npx --yes pnpm@12.3.4 build` and substitute `npx --yes pnpm@12.3.4 agentlive`.

## Server

After installing and building the workspace:

```sh
npx --yes pnpm@12.3.4 build
agentlive serve
```

The server listens on `127.0.0.1:7331` and persists state under `~/.agentlive`. First startup creates an owner-only credential file at `~/.agentlive/owner.json`; subsequent starts reuse it. The ready message reports the server URL. `/healthz` reports process liveness. `/readyz` returns 200 only when the recording root and sessions directory are accessible and the filesystem reports available blocks; otherwise it returns 503 with `{ "ready": false }`. Storage checks share one in-flight probe and a one-second response deadline. Readiness is an admission signal, not a guarantee that a subsequent write/fsync will succeed. Stop with Ctrl-C or SIGTERM to close storage cleanly.

For multi-session hosting, `serve --max-cached-sessions 128` sets the resident session cache capacity. Active requests and live connections retain their sessions; idle sessions can be evicted and reopened from JSONL. If every cached session is in use, new session loads receive a retryable capacity response. This limits resident session count, not total memory or retained disk usage. Programmatic `RecordingStore.get/create` calls acquire ownership and must be paired with `store.release(session)` when finished.


Server shutdown stops admission and drains accepted work. Configure its waiting deadline with `agentlive serve --shutdown-timeout-ms 30000` (default: 30 seconds; positive integer up to 2147483647). If the deadline expires, the CLI reports an error and cleanup continues while retaining the store lock. The library’s `close()` rejects with `ShutdownTimeoutError` (`code: "shutdown_timeout"`); use `whenClosed()` to await actual completion afterward. A timeout does not prove a pending write was canceled. Use a process supervisor for a hard termination deadline, including blocked event loops. On restart, publishers reconcile durable acknowledgements and retry unacknowledged events through the existing deduplication protocol.

Discover recordings hosted by your server with `agentlive list --server http://127.0.0.1:7331`. The command uses your owner credential and returns a JSON page with recording summaries and `nextAfter`. Continue with `--after <nextAfter>`; `--limit` accepts 1–100 and defaults to 50. Publisher credentials and anonymous access cannot list the server’s recordings. Pages are ordered by recording ID, and refreshing from the first page discovers recordings added before your current cursor.

## Importing native history

In another terminal, import a retained session:

```sh
agentlive import --agent codex --source /path/to/session.jsonl
agentlive import --agent claude --source /path/to/session.jsonl
agentlive import --agent kimi --source /path/to/session_ID/agents/main/wire.jsonl
agentlive import --agent opencode --source /path/to/opencode-export.json
```

Imports are private by default. Use `--visibility unlisted` or `--visibility public` to make a completed import readable without credentials. Import output includes the recording ID and conversion report; unsupported source objects remain visible in the report. Open the server URL in a browser and join using the recording ID. Private recordings require an access key; the owner secret in your local owner credential file can be used for viewing and listing. Keys stay in browser memory and are not included in share URLs.

Use `--state-dir` on both commands for isolated state, `--server` on imports for another server, and `--owner-file` for its credential JSON. An existing owner secret may instead be supplied through `AGENTLIVE_OWNER_SECRET`. Local artifact access defaults to the source directory; add explicit `--artifact-root` paths where needed. Moved Kimi exports require both `--native-session` and `--native-agent`. See `agentlive --help` for all options.

## Discovering and selecting native sessions

List native sessions with `agentlive discover --agent codex` (also `claude` or `kimi`). Use `--source-root <directory>` for a custom installation or copied history. Defaults are `$CODEX_HOME/sessions` (or `~/.codex/sessions`), `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`), and `~/.kimi-code/sessions`. For OpenCode, use `agentlive discover --agent opencode --native-server http://127.0.0.1:4096`; authentication uses `OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME`.

Discovery emits JSON identity/path metadata, with no transcript or title. Pass a file candidate's `source` to the existing `import` or `publish --agent <agent> --source <path>` command; OpenCode candidates provide `nativeServer` and `nativeSessionId` for publishing. Multiple histories for one identity remain separate candidates. Discovery does not launch agents or merge parent/subagent logs.

To select by identity directly, use `agentlive publish --agent claude --native-session <id>` (also `codex` or `kimi`), optionally with `--source-root <directory>`. The same selection works for native `import`. A missing session, multiple matching histories, or a truncated scan fails before creating a recording. Narrow the root or supply an explicit source path; Kimi also supports `--native-agent <id>` to select one agent log. Selection uses the same durable import/publishing binding as an explicit source path, including `--resume-import`. It attaches to retained file history and follows new complete records; it does not start or control the native agent process.

Results are sorted by modification time and limited to 50 by default (`--limit` accepts 1–200). File discovery skips symlinks, scans at most 10,000 entries through eight directory levels, and inspects at most 128 lines within a 256 KiB prefix per file. `truncated` reports result, depth or scan limits; `skipped` counts unreadable or unrecognized sources. Missing roots return an empty list. OpenCode discovery lists the native server's workspace scope; broader workspace discovery remains open. A discovered candidate still requires full validation during import/publish.

## Publishing live sessions

Follow a retained Codex JSONL history and publish subsequent appends:

```sh
agentlive publish --agent codex --source /path/to/session.jsonl
```

Start `serve` first using the same state directory. Publishing defaults to private visibility. Use `--record-format legacy` for older histories without structured item records. Stop with Ctrl-C and run the same command to resume the same recording; it stays open, and pending captured events remain on disk. The initial retained history is included. Source catch-up and remote delivery are separate states: `source-caught-up` reports local conversion, while publisher status reports network progress.

File following supports Codex, Claude Code, and Kimi Code; OpenCode uses its native server as described below. Initial recording creation needs connectivity; an existing binding can capture text while disconnected. Attachment upload can pause conversion until connectivity returns. Compatible ended imports can continue live with `--resume-import` and their original import options.

Claude Code uses the same durable publication path:

```sh
agentlive publish --agent claude --source /path/to/session.jsonl
```

It backfills retained messages and tool state, then follows complete appended records. Partial trailing writes remain deferred until the next append. Restarting reconstructs tool state before processing new results. Native inline images/documents use the existing attachment spool; unsupported native objects retain explicit capture gaps. Token deltas absent from the native history are not reconstructed. Use `--include-children` to capture subagent transcripts in the same recording (see family capture below).

Kimi Code can publish one retained agent wire log:

```sh
agentlive publish --agent kimi \
  --source /path/to/session_ID/agents/main/wire.jsonl
```

The adapter derives native identity from the session directory. For a moved wire file, provide both `--native-session <id>` and `--native-agent <name>`. Goals, tasks, recorded interactions, and plans share the same stateful conversion used by historical import. Without `--include-children` a binding follows one agent file; see family capture below to combine the main agent and its sibling agent logs.

Continue an imported session as a live recording:

```sh
agentlive publish --agent claude \
  --source /path/to/session.jsonl --resume-import
```

Use the same state directory, server, source prefix, filtering policy, title, visibility, and artifact settings as the import. With `--resume-import`, the default title matches the import command's default. For Codex, select the same structured/legacy format as the imported prefix. The transition preserves the recording ID, producer sequence, and existing attachment identities. Its durable intent and idempotent reopen operation allow retrying the same command after a lost response or process restart.

The import must already be fully uploaded and ended. Changed converters or filtering policies still require a separate migration. OpenCode imports continue through the native server as described below. Once the transition starts, the import command rejects that binding to avoid ending a recording being continued live.

Publish an existing OpenCode session through its native headless server:

```sh
# Start OpenCode with your configured provider and existing server credentials.
opencode serve --pure --hostname 127.0.0.1 --port 4096

# In another terminal, attach AgentLive to the native session.
agentlive publish --agent opencode \
  --native-server http://127.0.0.1:4096 --native-session <session-id>
```

Use `OPENCODE_SERVER_PASSWORD` (and `OPENCODE_SERVER_USERNAME` when configured) in the publisher's environment for native server authentication. `--server` selects the AgentLive destination separately. Initial attachment validates native identity/authentication before creating the remote recording. Repeat the command to resume the same publisher binding; native-server reconnect and AgentLive-server reconnect run independently. An existing binding keeps capturing available native snapshots while AgentLive is offline, then sends its durable backlog.

OpenCode publishing currently preserves observed snapshots, not every native text delta. It captures base64 data-URL files and tool attachments; local `file:` references require explicit `--artifact-root` access. Authenticated remote artifact URLs (`--remote-artifact-policy`) and import continuation (`--resume-import`) are supported; revert presentation is described in [OpenCode revert](opencode-revert.md). The installed-agent integration test covers three native turns, native server restart, a turn while publication is detached, and deduplicated publisher restart:

OpenCode local artifact access is disabled by default. Allow a directory explicitly when its native references point to files available on this machine:

```sh
agentlive publish --agent opencode \
  --native-server http://127.0.0.1:4096 --native-session <session-id> \
  --artifact-root /path/to/allowed/artifacts
```

Inline files retain their embedded bytes; local files without a recorded original hash are labeled as current-file copies. Text artifacts are filtered before storage. Upload completes before an available attachment/link event is published, and retries reuse immutable captured bytes even if the original file disappears. Raw data URLs are not copied into broadcast reference events. Returning to a previously captured file version reuses that version's reference without announcing it twice.

Historical OpenCode imports use converter version `opencode-export-2` for the same file and tool-attachment support. Existing imports pinned to the older converter still require migration or a separate publisher state directory.

New OpenCode snapshot imports can continue in the same shared recording:

```sh
agentlive import --agent opencode --source session-export.json --title "My session"
agentlive publish --agent opencode --native-server http://127.0.0.1:4096 --native-session <native-session-id> --source session-export.json --resume-import --title "My session"
```

Use the same state directory, target server, title, visibility, filtering secrets, and artifact settings. Retain the original export unchanged. After the first successful transition, publishing can restart with the same arguments; `--resume-import` is then optional, but `--source` remains required to verify the imported prefix. Native authentication secrets must already be included in the import’s filtering policy if they add to that policy. The importer now uses converter `opencode-snapshot-4`; earlier export converters still require migration before continuation.

## Publication control

Every live `publish` prints a `publishing` event containing the recording ID and its stable browser `viewerUrl` (`<server>/?stream=<id>`). The server also redirects the short form `<server>/s/<id>` to it. Either URL can be passed directly to terminal viewers: `agentlive watch <viewer-url>` and `agentlive replay <viewer-url>` select both the server and the recording.

Local publisher bindings live under `<state-dir>/publisher/<hash>`. These commands inspect and control them without printing credentials or recorded content:

```sh
agentlive status [--stream <recording-id>]   # JSON list of bindings
agentlive pause --stream <recording-id>      # persist paused sharing
agentlive resume --stream <recording-id>     # re-enable sharing
agentlive finish --stream <recording-id>     # deliver captured events, then end
agentlive reopen --stream <recording-id>     # reopen a recording finished here
agentlive retire --stream <recording-id>     # set a finished binding aside
agentlive doctor [--server <origin>]         # runtime/credential/server/agent checks
```

`status` reports, per binding: agent and native session, server and recording, the viewer URL, whether a publisher process is currently attached (it holds the binding's kernel lock), sharing intent, lifecycle (`open`, `finishing`, `finished`, `reopening` or `transferred`), captured/acknowledged/pending event counts, the oldest undelivered event's capture time, local journal and artifact-spool sizes, and any pending credential rotation. Counts that require the journal lock are `null` while a publisher is attached.

`pause` and `resume` change the durable sharing intent of a detached binding; stop a running `publish` (Ctrl-C) first. While paused, AgentLive neither captures new native records nor delivers already captured events, and `publish` refuses to start with `Publishing is paused`. The native agent and its own history are unaffected. **Pause withholds rather than discards:** after `resume`, file adapters catch up from their saved cursor, so native history written while paused is captured and delivered (OpenCode captures the then-current snapshot). To keep that period out of the recording, finish the binding instead of resuming it. Select a binding with `--stream` or, when several bindings publish the same recording, with `--source <binding-directory>`.

`finish` drains the already captured journal to the server and appends a `recording.ended` lifecycle event at that exact producer boundary; it does not read native sources again. Its operation ID is persisted before the remote request, so rerunning `finish` after an interruption completes the same operation. A finished binding refuses further `publish`. `reopen` persists its own intent, appends `recording.reopened` to the same recording, and retires the finish record, after which the original `publish` command continues capture into the same URL. Imports are continued with `publish --resume-import` instead. The lower-level `finish-publisher --source <dir> --operation-id <id>` remains available for scripted use.

`retire` moves a finished, transferred or fully delivered imported binding to `<state-dir>/publisher/retired/` while holding its lock. Bindings are keyed by server, agent and native session, so this is how to start a *new* recording of a native session that already has one: the next `publish` creates a fresh binding and recording and, for file agents, captures the retained native history from the beginning. Retired directories are kept for inspection and are not listed by `status`.

`doctor` checks the Node version, state-directory and owner-credential permissions, server `/healthz` and `/readyz`, local publisher bindings needing attention, and whether each native agent is on `PATH` with its default history root. It prints JSON and exits nonzero when a check fails.

## Managed launch

Add `--launch --cwd <project>` to resume the selected Codex, Claude or Kimi session in its native terminal while publishing. AgentLive validates and captures retained history before invoking `codex resume <id>`, `claude --resume <id>` or `kimi --session <id>` with inherited terminal input/output. Publication diagnostics go to stderr. Kimi managed resume requires the main agent log; use `--native-agent main` when discovery also finds subagents. Native permissions and provider configuration remain controlled by the installed agent.

After the native process exits, AgentLive waits up to 30 seconds for its remaining source bytes to reach the local durable journal, then detaches without ending the recording. Server delivery may still be pending and resumes on reattach. An incomplete final native record or a blocked capture causes an explicit drain/recovery error. Capture failure leaves the native terminal usable until it exits; interrupting AgentLive terminates its owned native process.

For a new Codex session, use `agentlive publish --agent codex --launch --cwd <project>`, optionally with `--include-children`. AgentLive creates an empty native thread using the app-server's `historyMode: legacy` rollout contract, saves its identity under `<state-dir>/launches/<id>.json`, and names it using `--title` before closing the server. Naming materializes the rollout; AgentLive verifies its identity, starts file capture, and invokes `codex resume <id>` in your terminal. No model turn is submitted during creation. Model and permission settings use native defaults. This rollout storage contract is separate from AgentLive's structured event conversion. Installed-version support for these app-server calls is required; unsupported creation, missing rollouts, or mismatched identities fail before terminal launch. The saved ID is available for diagnosis/recovery, but a failed materialization may not leave a resumable native session. The opt-in `node scripts/probe-codex-launch.mjs` creates a named empty verification thread in native history and checks separate-process resume without inference or publication. Real interactive/version acceptance remains open.

For a new Kimi session, use `agentlive publish --agent kimi --launch --cwd <project>`, optionally with `--include-children`. AgentLive uses ACP protocol 1 `session/new`, saves the returned native ID and its existing file-adapter identity under `<state-dir>/launches/<id>.json`, closes ACP, and verifies the matching main wire log before capture and terminal launch. Kimi's protocol ID has a `session_` prefix; the AgentLive recording/discovery ID retains the existing suffix convention. Fresh terminal launch passes the full native protocol ID. No prompt is submitted during creation, and native folder trust, model and approval flows remain in the terminal. Discovery defaults to `~/.kimi-code/sessions`; `--source-root` can select another retained-log location but does not reconfigure native Kimi storage. Missing or ambiguous discovery and invalid metadata fail before terminal launch, retaining any saved identity for diagnosis. The opt-in `node scripts/probe-kimi-launch.mjs` leaves an empty native verification session and checks its wire log and separate-process listing without inference or publication. Actual terminal trust/resume, supported-version and provider acceptance remain open.

For a new Claude session, omit `--native-session`: `agentlive publish --agent claude --launch --cwd <project>`. AgentLive generates a UUID, saves it under `<state-dir>/launches/<uuid>.json` before spawning, and invokes `claude --session-id <uuid>`. It waits for a matching retained transcript before binding capture. The `native-identity-saved` diagnostic contains the UUID to use with `--native-session` on restart. An exit without an identified transcript reports an error and retains the launch record. Discovery limits still apply; a truncated or ambiguous scan requires narrowing `--source-root`. Native transcripts retain capture until the publisher can bind; first-time offline durable AgentLive capture remains an open gate. Arbitrary native argument forwarding and real interactive acceptance across supported versions remain open.

OpenCode managed launch is `agentlive publish --agent opencode --launch --cwd <project>`, optionally with `--native-session <id>` to resume. AgentLive starts an authenticated loopback native server, creates or verifies the session through its API, saves its identity in `<state-dir>/launches`, captures the first snapshot, and opens `opencode attach` with inherited terminal I/O. The managed-server password is stored privately in `<state-dir>/managed-opencode-credential.json` and reused across launches so the capture policy remains stable. Keep this file with the publisher state; deleting or rotating it requires capture-policy migration. Passwords are passed through the environment, not command arguments or launch records.

When the OpenCode terminal exits, AgentLive fetches and durably captures one final snapshot before closing its owned native server. The recording remains resumable; server upload can remain pending. A final-reconciliation failure reports recovery required. Closing the terminal also stops this managed server and can interrupt native work still running there. Capture failure leaves the terminal available until exit; native-server failure terminates the owned terminal. This path does not adopt an external server or continue an imported export; use the existing `--native-server` publishing path for those workflows. Real interactive/provider and native-work interruption acceptance remain open.

## Parent and subagent (family) capture

When an OpenCode session declares `parentID`, capture preserves that explicit relationship as linked agent entries. The parent entry has unknown status; its messages and tools are not fetched by single-session capture. The child entry also remains unknown rather than inferring completion from a completed turn. Repeated snapshots and publisher restarts preserve the same relationship without duplicate events. Invalid, self-referencing, changed or disappearing parent identities are rejected. Single-session capture does not merge related transcripts; use the explicit family option below.

Discover a selected OpenCode session's direct children with `agentlive discover --agent opencode --native-server <origin> --parent-session <id>`. This queries the native children endpoint and validates each returned child's parent identity. Results include `parentNativeSessionId`; normal OpenCode discovery also preserves this field when present. Limits and truncation reporting still apply. This command lists one generation; it does not recursively publish descendants. Each returned child can currently be selected for a separate recording.

For one recording containing an OpenCode session and its descendants, add `--include-children` to external-server publishing or managed launch. Each root reconciliation discovers the current descendant tree and captures child snapshots into the same durable journal. Child converter state and message/tool/attachment identities are isolated by native session, and child messages/tools carry their owning agent reference. Restart reuses the same child state and suppresses duplicate revisions. Managed terminal exit reconciles the family before shutdown.

Family capture is bounded to 200 sessions including the root, eight descendant levels, and 199 retained child converters per publisher process. Truncated, invalid, cyclic, reparented or conflicting sources stop capture with a recovery error. Discovery and snapshots are sequential observations, not an atomic native family snapshot; newly created children may appear on the next reconciliation. Children absent from later listings retain their captured history without an inferred completion or deletion. The family option is pinned in the publishing manifest: changing an existing recording's scope, or continuing a single-session import as a family, requires migration. Native failure/deletion/attachment coverage and rendered family acceptance remain open.

Kimi multi-agent capture uses `agentlive publish --agent kimi --source <session-dir>/agents/main/wire.jsonl --include-children`. The session directory must be named `session_<native-id>`, with logs at `agents/<agent-id>/wire.jsonl`. AgentLive combines these logs into one recording, keeps agent-scoped message/tool identities, discovers new logs on each poll, and saves an independently verified source cursor per child. Child updates are captured even while the main log is idle. Shared session membership does not establish parent ownership, so no parent relationship is inferred from a sibling directory.

To expand an existing live Codex, Claude or main-agent Kimi recording, publish with `--include-children --expand-family` and its original source, title, visibility, filtering and artifact options. Codex also uses `--source-root <rollouts-directory>`. This explicitly changes only the capture scope: recording identity and existing events stay intact, and child history is appended. The new family scope is atomically pinned before capture, so retry with `--include-children` after interruption. Concurrent title, filtering, artifact or conversion changes are rejected. Scope cannot shrink again. This command requires an existing live file publication and cannot combine with `--launch` or `--resume-import`; for file recordings originating from single-session imports, first resume with the original single-session options, then detach and run the explicit expansion command. AgentLive retains the verified original resume identity in an expansion record; subsequent family attaches preserve both that provenance and the expanded policies. For an existing live OpenCode recording, use `publish --agent opencode --native-server <origin> --native-session <id> --include-children --expand-family` with its original capture policies. It preserves the main capture state and appends child history; the native authentication/filter policy must match the existing publication. For OpenCode recordings originating from single-session imports, first complete the original single-session resume, then detach and expand with the same original export, title, visibility, artifact roots and filtering settings. The expansion record pins the prior live policies and verified import transition; interrupted manifest updates can be completed on the next family attach. General converter/filter migration remains pending.

Historical Kimi family import is available with `agentlive import --agent kimi --source <session-dir>/agents/main/wire.jsonl --include-children`, or with `--native-session <id> --native-agent main --source-root <directory> --include-children`. It freezes the selected main log and every discovered sibling log, preserves their separate agent identities, uploads privately, and ends the recording before applying the requested visibility. The import manifest pins child paths and prefix hashes; retrying an unchanged family reuses the recording, while changed children, membership or capture scope require an explicit new import/migration. Logs created after discovery and bytes appended beyond each frozen boundary are outside that import. This is a set of per-file boundaries, not an atomic native multi-agent snapshot. Export and offline replay include captured child events. Continue the same Kimi family with `publish --agent kimi --source <main-wire-log> --include-children --resume-import` and the original import title, visibility, artifact and filtering options. Before reopening, AgentLive verifies every imported child prefix and seeds its live checkpoint; rewritten, missing or relocated imported children stop continuation. Newly appended output and newly discovered children can then join the same recording. Later attaches retain the same family scope.

Kimi family capture accepts at most 199 child logs. Unexpected layouts, incomplete discovery, replaced/missing captured logs and changed retained prefixes report recovery errors. The publishing scope is pinned; changing an existing single-log binding or resuming its import as a family requires migration. Native version/fidelity and artifact acceptance remain open. Managed family resume is available with `--launch --native-session <id> --native-agent main --include-children`, optionally `--source-root <directory>`. After native exit, a fresh discovery pass drains each child and the main log through their observed byte boundaries. An incomplete final record produces a recovery error. The native process can have independently running descendants; logs written after the final scan require a later reattach.

Historical Claude family import is available with `agentlive import --agent claude --source <main-transcript.jsonl> --include-children`, or explicit native-session discovery with the same flag. It freezes the main transcript and up to 199 `subagents/agent-<id>.jsonl` files, validates session and child ownership, and captures child messages, tools and inline attachments into one ended recording. Child identities stay separate even when native UUIDs repeat. Import retries pin the discovered child paths and prefix hashes; changed membership, contents or scope require a new import/migration. Each file has its own frozen boundary, so this is not an atomic native snapshot. A child transcript cannot serve as the family root. Continue the same Claude family with `publish --agent claude --source <main-transcript.jsonl> --include-children --resume-import`, retaining the original title, visibility, artifact and filtering options. Every imported child prefix is validated before reopen; missing, changed or relocated sources fail explicitly. Existing checkpoints never move backward during converter reconstruction. Later output and new subagents are captured into the same recording.

Claude family capture uses `agentlive publish --agent claude --source <main-transcript.jsonl> --include-children`, or adds `--include-children` to managed fresh launch/resume. It follows `<main-transcript-directory>/<session-id>/subagents/agent-<agent-id>.jsonl`. Child records must explicitly match the owning session, filename agent ID and `isSidechain: true`. Message/tool/attachment/monitor identities and clocks are scoped to the subagent; child messages and tools refer to their agent entry. No immediate parent is inferred when the source supplies only shared session membership.

Claude discovery labels sidechain candidates with `nativeAgent`; selecting a main session by ID excludes those candidates. Family capture retains independent child cursors, discovers new logs while the main transcript is idle, and performs a post-exit family drain during managed launch. Limits are 199 child logs and 10,000 directory entries per scan. Changed prefixes, conflicting ownership, replaced/missing captured logs and incomplete final records report recovery errors. Existing single-transcript bindings/imports require scope migration; live native fidelity, artifact and rendered acceptance remain open.

Historical Codex family import is available with `agentlive import --agent codex --source <main-rollout> --source-root <rollouts-directory> --include-children`, or explicit `--native-session <root-id>` selection. The default family root is `$CODEX_HOME/sessions` or `~/.codex/sessions`. Bounded discovery validates each descendant's path to the selected root; import freezes every file and pins child paths/prefix hashes in its manifest. Structured children may contain copied ancestor metadata, and empty children may contain metadata only. Unrelated metadata, ambiguous sources and broken lineage fail explicitly; mixed-thread legacy response history still requires reconciliation. Child objects retain separate identities when native item IDs repeat. Unchanged import retries reuse the ended recording; changed history/membership/scope require a new import/migration. File boundaries are independent, not an atomic native snapshot. Continue a Codex family import with `publish --agent codex --source <main-rollout> --source-root <rollouts-directory> --include-children --resume-import`, retaining the original import title, visibility, artifact and filtering options. Each imported child prefix and the discovered parent chain are verified before reopening; child checkpoints retain their greatest committed offsets during reconstruction. The selected `--record-format` must match captured content in both the main and child imports. Metadata-only prefixes permit either format, while incompatible mixtures require reconciliation. New descendants and appended output can then join the same recording.

Historical OpenCode family import accepts native per-session exports: `agentlive import --agent opencode --source <root-export.json> --source-root <exports-directory> --include-children`. Produce each file with the native `opencode export <sessionID>` command. The directory must contain only the selected family's JSON exports (other non-JSON files are ignored); nested directories are supported within eight levels, with at most 200 exports and 10,000 scanned entries. Symlinks, duplicate session exports, malformed JSON exports, unrelated sessions and broken parent chains are rejected. Every export is validated and hash-pinned before capture, then read against that hash. Import reads retained files and requires no native server. Messages, tools, inline/local attachments and explicit parent links use the same isolated child capture as live publication. Unchanged retries reuse the ended recording; changed exports or scope require a new import/migration. These are independently exported snapshots, not an atomic native family snapshot. Continue with `publish --agent opencode --native-server <origin> --native-session <root-id> --source <original-root-export.json> --include-children --resume-import`. Keep every original child export at its saved path. Before reopening, AgentLive verifies export hashes, discovers the native family, checks imported session creation times and parents, and validates retained child capture policies. Missing/reparented native children, changed exports and conflicting filtering options leave the recording ended. Retain the original title, visibility, artifact and filtering options; if native server authentication is used, its password must already be included in the import filtering policy. Later snapshots and newly discovered children can join the same recording.

Codex discovery distinguishes the shared logical `nativeSessionId` from `nativeThreadId` and optional `parentNativeThreadId`. Selecting a main session by ID excludes separate child-thread rollouts that share its logical identity. Inspection preserves parent-thread metadata, rejects self-parenting or contradictory lineage, and allows newly appended threads with consistent ownership. Codex family capture is available with `publish --agent codex --native-session <id> --include-children --source-root <rollouts-directory>`, optionally adding `--launch` for managed resume. An explicit `--source <main-rollout>` may also be combined with the family source root. The default discovery root is `$CODEX_HOME/sessions` or `~/.codex/sessions`. Parent chains must lead to the selected root; ambiguous thread files, missing/cyclic lineage, changed retained prefixes, and incomplete final records fail explicitly. Capture is bounded to 200 discovered threads, eight descendant levels and 199 retained child converters. The family root is pinned in the publishing manifest; changing it requires migration. Managed exit performs a fresh family scan and drains observed child/main boundaries. Structured child rollouts may contain copied ancestor metadata: the coordinator verifies those thread IDs against the selected parent chain and omits their duplicate metadata during child conversion. Foreign-thread structured items are rejected. Mixed-thread legacy child rollouts remain unsupported because they lack the structured ownership guarantees. `node scripts/validate-codex-children.mjs` performs read-only conversion validation of four installed child rollouts containing ancestor metadata, printing only aggregate counts. Native family fidelity, artifacts and rendered acceptance remain open.

## Attachments and artifacts

Codex, Claude, Kimi and OpenCode import and publishing can capture HTTP(S) attachments with `--remote-artifact-policy <file>`, using explicit allowed origins and credentials from named environment variables. Captured bytes survive source disappearance and portable archive round trips. See [configuration, provenance, and current limits](docs/remote-artifacts.md). Add `--artifact-bundles` to capture supported HTML dependencies into one portable attachment; see [bundle capture and current limits](docs/artifact-bundles.md).

## Terminal replay

Inspect an imported recording in the terminal:

```sh
agentlive replay --stream <recording-id>
# For a public or unlisted recording on another server:
agentlive replay --stream <recording-id> --server https://example.test --anonymous
```

Replay downloads a fixed history boundary and prints timestamped messages, tools, file changes, attachment links, and capture gaps. Terminal control characters are escaped. By default it prints immediately. Add `--speed 2` for timing at twice the recorded speed, or `--interactive` for terminal controls: space pauses/resumes, `.` or Right Arrow steps one recorded event and shows its state while remaining paused, `+`/`-` changes speed, and `q` quits. Timed replay starts at the first event and preserves subsequent recorded gaps. Add `--idle-cap-ms 1000` to cap each inter-event gap at one second of recorded time before speed scaling (at `--speed 2`, at most half a second of waiting). A cap of zero removes timing gaps while retaining every event. The option also works with watch and enables timed playback at 1× when no speed is supplied. With `watch --resume-view`, the cap is saved with playback preferences and restored on the next invocation. An explicit value overrides it; `--idle-cap-ms off` clears it and restores uncompressed timing. `--restart-view` resets saved preferences. Replay uses the cap only for the current invocation. Add `--from-ms 30000` to reconstruct the state at 30 seconds and continue from there; all events at that timestamp are included in the state view. Positions beyond the fixed history boundary show its final state. Replay uses paged filesystem state with a 512 MiB content quota. Interactive replay supports `,`/Left Arrow for the previous exact event, `[`/`]` for 30-second seeks, and `0` for the beginning. These keyboard seeks pause playback; space resumes. Interactive replay remains open at its fixed end boundary until `q`, so earlier events can still be inspected. The same controls work with offline `.agentlive` replay. Remote reseeking reads the originally captured history boundary and requires server access; archive reseeking reads the local recording. Current reseeks reconstruct the selected prefix with bounded batches; accelerated repeated-seek performance remains unverified. Live watch supports cached seeking and independent receipt. Private replay uses the same owner credential options as import.

Terminal `replay` uses paged filesystem state and streams text through 4,096-unit reads. `replay --from-ms` can start from an existing server snapshot at or before the requested time and reduce only its remaining suffix. Replay creates a private temporary content directory with a 512 MiB encoded-content quota and removes it on normal exit or handled cancellation; forced process death can leave temporary files. It no longer uses the reference replay's 64 MiB event-counting limit. Content collection and measured long-session throughput remain unfinished. Live `watch` also uses paged presentation state, with a separate durable event cache for receipt. It retains up to 32 derivative seek checkpoints and replays their missing cached suffixes; receipt continues while presentation is paused or seeking. Watch has separate 512 MiB limits for the event cache and derived content, and content collection remains unfinished.

## Terminal watch

Watch a recording with automatic history catch-up and reconnect:

```sh
agentlive watch --stream <recording-id>
```

Use `--anonymous` for recordings that permit anonymous reads, or the existing owner credential options for private recordings. The local subscriber cache stores checksummed JSONL under `<state-dir>/subscriber`; it contains received recording content, but does not store the connection credential. Restarting displays the cached prefix and then reconnects from its durable receipt cursor. Cached history can render while the server is offline. Reconnection never silently switches to a different recording revision.

The terminal viewer renders messages, tools, and supported state updates from paged playback state. With `--interactive`, space pauses/resumes, `.` or Right Arrow steps forward one event, and `,` or Left Arrow steps backward one event; stepping leaves presentation paused. Press q to quit. Receipt continues into the durable cache while presentation is paused or awaiting an asynchronous output sink. On resume, presentation reads the cached backlog in order. Add `--resume-view` to save presentation progress and reconstruct that position on the next launch. Use `--restart-view` to reset presentation to the beginning while keeping the receipt cache. These options are mutually exclusive; without either, watch displays history from the beginning. Historical positioning uses cached events and eligible local or server checkpoints. Durable cache and content quotas remain separate from the paged working state; long-session performance acceptance remains open.

Watch cancellation has a configurable 30-second deadline: `agentlive watch --stream <id> --cancellation-timeout-ms 5000` limits the caller’s wait after cancellation to five seconds. If accepted cache work is still pending, the watcher reports `CancellationTimeoutError` and retains the cache lock until cleanup drains. Library callers can await `error.whenDrained` for eventual completion or failure. This combines responsive cancellation with exclusive cache ownership; it does not force-cancel disk I/O. A blocked JavaScript event loop can delay the deadline.

To watch with recorded timing, use `agentlive watch --stream <id> --speed 1 --interactive`. Space pauses presentation, +/- changes speed, `l` resumes immediate live catch-up, and `q` exits. Receipt continues while playback is paused or slowed. Without `--speed`, watch catches up immediately. Catch-up preserves every event in order; it does not discard intervening history. `--resume-view` also restores the timing anchor at the saved presentation position.

With `watch --resume-view`, playback speed, pause state, and timed/live catch-up mode are saved separately from the event cache and viewing position. Interactive restart shows the saved snapshot even when paused. Noninteractive restart resumes unpaused; an explicit `--speed` overrides saved speed and selects timed playback. `--restart-view` resets both viewing position and playback preferences. Ordinary watch without either flag does not restore or update these preferences.

Start a live viewer at a particular recorded time with `agentlive watch --stream <id> --from-ms 30000 --speed 1 --interactive`. The viewer fetches a fixed server history boundary, receives that prefix, displays its state at 30 seconds, then continues with the remaining and newly arriving events. A position beyond the boundary clamps to its latest event. Explicit `--from-ms` overrides a saved viewing position; with `--resume-view`, the selected event position is saved after its snapshot is displayed. Seeking uses the fixed initial server boundary and cached history. Presentation reconstructs from local paged checkpoints or a newer authorized server snapshot bounded by the selected event sequence, then reduces the cached suffix and streams bounded text ranges. Snapshot acceleration preserves full durable event receipt. Temporary snapshot-selection transport failures fall back to cached reconstruction; imported pages still require the server until fetched. Its former 64 MiB reference-state event counter has been removed.


During interactive watch, `[` seeks back 30 seconds, `]` seeks forward 30 seconds, and `0` returns to the beginning. These controls pause presentation for inspection; space resumes and `l` catches up live. Seeking uses the currently received cache, so it also works during a network outage once history is cached. Programmatic viewers can call `PlaybackPacer.stepBackward()` to restore the preceding exact event prefix while pausing, or `PlaybackPacer.seek(milliseconds)` for an exact target and observe completion through `onPositioned`. Programmatic seeking preserves the controller’s pause state. Requests beyond received history clamp to its latest event.


Saved viewer positions retain an explicit seek time between events. For example, seeking to 30 seconds between events at 0 and 60 seconds and restarting with `--resume-view` restores the 30-second snapshot and timing anchor. Older sequence-only checkpoints still load at their event timestamp. This preserves selected seek positions; continuously elapsed playback time between events is not checkpointed on every clock tick.

In interactive terminal watch, `.` advances exactly one recorded event, shows the resulting playback state, and remains paused. Receipt continues independently. Repeated presses queue at most 1,024 steps; a seek or explicit pause/resume clears queued steps. Step requests are transient and are not restored across restart.

## Browser viewer

The server root serves the React viewer on the same origin as recording APIs. Join or leave a recording, browse an owner-authorized page of sessions, pause while receipt continues, seek with the timeline, select playback speed, or follow incoming events. Messages, tools, file changes, and versioned attachments appear in first-event order. Agents, tasks, goals, recorded approvals/questions, plans, and monitors have structured cards with status and ownership. Related agents/tools link within the recording, and captured plan files open through the attachment inspector. Recorded decisions are passive history; raw event fields remain available under Recorded data. Open an attachment version in the inspector to preview supported content or download the verified file. Loading uses the joined session's credential, the exact announced size, a 25 MiB limit, and SHA-256 verification. Plain UTF-8 text (including HTML/SVG source) is displayed as text up to 1 MiB. Static PNG, baseline/progressive JPEG and static WebP previews require bounded dimensions and valid framing; animation is download-only. HTML attachments and captured [artifact bundles](artifact-bundles.md) render in an isolated, script-disabled preview by default, with an explicit isolated interactive mode for captured scripts. Other files remain downloadable. Closing the inspector cancels loading and releases its object URLs.

With playback caching enabled at join, the browser uses a paged IndexedDB content store and atomically publishes reducer state and activity ordering. Reload authenticates first and continues from the saved receipt cursor. A fresh cache can adopt an existing paired server snapshot and receive only its event suffix. The server automatically schedules snapshots for cached sessions through one background worker: at 1,000 pending events, after 30 seconds, or after a recording ends. It checks for work every second, rotates sessions between builds, and retries failures after 30 seconds. Builds have a 30-second cancellation deadline; timed-out target batches shrink on retry. Restart reuses published checkpoints when a recording is next loaded. These scheduling intervals are not latency guarantees. Snapshot manifests and pages are transferred with size/hash verification and cached as needed; uncached content still requires the server, so this is not a complete offline recording copy. The feed loads indexed row windows, card metadata and bounded text ranges instead of retaining the complete event array. Seeking downloads fixed-boundary history suffixes and reconstructs a separate immutable presentation; receipt continues independently. A bounded catalog retains paired seek checkpoints sampled from receipt and explicit seeks. Backward seeking considers local checkpoints and paired server snapshots bounded by both sequence and playback time, then downloads only the missing suffix. If no eligible prefix exists it starts from the beginning. Historical suffix downloads currently require server access. The content store has a 512 MiB encoded-blob quota; content collection and measured long-session heap/seek limits remain unfinished. A storage or concurrent-writer conflict reports an error requiring rejoin/recovery rather than silently changing the durable cursor. With saving disabled or IndexedDB unavailable, the same paged viewer runs on a visit-local memory store (64 MiB / 65,536 encoded blobs by default) with automatic collection of unreachable intermediate content. Clear playback cache closes the current viewer and removes local copies without deleting server recordings. Access keys and attachment bytes are not persisted by this browser content store. Hidden pages suspend receipt; foreground recovery revalidates access and catches up without moving a paused view. Actual desktop/mobile storage, lifecycle and visual verification remain release work.

When playback caching is enabled, the browser also saves the exact presented event, selected timeline position, speed, and paused/playing/follow mode. Rejoining restores that view from a verified history prefix while receipt catches up separately. A paused view does not reveal later events with the same timestamp. Control changes schedule an immediate save; moving playback checkpoints are coalesced to once per second, with a final flush on leave and a best-effort flush when hidden. Abrupt browser termination may lose recent unsaved view changes. Preferences are local to this browser profile and recording revision; the last preference transaction wins across tabs, without changing another tab’s current view. Clearing the playback cache removes these preferences too.

The browser player has Previous event and Next event controls. Each pauses playback and selects the exact adjacent event prefix, including events with tied timestamps. Cached sessions save that exact selection for reopening; receipt continues independently. The paged mode may fetch historical events while stepping.

The activity feed uses a measured scrolling window, so offscreen cards are unmounted. Tool/edit and Recorded data expansion choices survive scrolling within the joined viewer. First/Latest controls and arrow/Home/End keys navigate items, and ordinary agent/tool links reveal their destination before focusing it. While following live, the feed stays at the end only if you are already within 48 pixels of it. The saved-history path uses paged state and indexed rows; the memory-only fallback retains its event limit. Native browser find cannot search unmounted cards; use Search. With playback caching enabled, expansion choices are saved across leave/reload (up to 128 per recording). Real desktop/mobile scrolling and accessibility validation remain release gates.

Use Search in the activity feed to find case-sensitive literal text across visible objects at the selected playback position, including offscreen messages, tool input/output, edits, workflow fields, attachment metadata, and capture notes. Search pauses presentation while receipt continues. Results include short excerpts and come in pages of at most 50 matching objects; selecting one reveals and focuses its card. Changing the playback position invalidates old results. Search does not download attachment contents or inspect future/hidden objects, and ordinary browser Find still only sees mounted content.

Long message/tool/diff text and recorded-data blocks now have text-page controls, keeping one bounded page per field in the DOM. First/Previous/Next access the full text; Follow latest text keeps the last page visible as it grows and can be toggled off. Manual page choices survive virtual scrolling within the joined viewer. Search selection opens the page containing the beginning of its match in applicable text fields. This reduces rendered text size; the paged viewer reads referenced text ranges while the memory-only fallback retains transcript strings. With playback caching enabled, explicit page choices and attachment-version list pages are saved across leave/reload; automatic latest-page defaults are kept for the visit.

The browser player's **Idle gaps** control offers original timing, no waiting between events, or a one-/five-second maximum recorded gap. The cap applies before playback-speed scaling and preserves recorded timestamps and event order. With playback caching enabled, the cap is restored on rejoin; clearing the cache resets it. Follow live remains immediate. Paged historical playback may still need server access for missing history/content.

## Portable recordings

Export a frozen recording prefix, replay it offline, or import it into another server:

```sh
agentlive export --stream <recording-id> --output session.agentlive --server http://127.0.0.1:7331
agentlive replay --source session.agentlive
agentlive replay --source session.agentlive --from-ms 30000 --speed 4
agentlive import --source session.agentlive --server http://127.0.0.1:7331
```

Use the usual owner credential file or `AGENTLIVE_OWNER_SECRET` for private export and server import. Public/unlisted exports also support `--anonymous`. Export refuses to replace an existing output file. Offline replay needs no server or credential and supports the existing terminal playback controls.

The `.agentlive` file is a ZIP containing a versioned `manifest.json`, the filtered `events.jsonl` prefix, and every published attachment version referenced by that prefix under `attachments/<sha256>`. Pending/unavailable attachments remain pending/unavailable. An active recording can continue while its captured prefix is exported. Imports receive a new identity/revision, start private, and are ended; a live-prefix import adds a final server lifecycle event without changing its captured observations. Native-history import remains `import --agent <agent> --source <native-file>`.

The manifest records the source recording boundary, known agent/provenance, format versions and file hashes. Unknown source/adapter versions are represented explicitly as null. Server owner/publisher credentials and unpublished spool data are excluded. Default offline playback treats embedded content as data; attachment output identifies the corresponding ZIP entry. Derived snapshots are omitted from the initial portable format and regenerated during playback. This version accepts event and attachment entries, not optional snapshot/content entries from future format revisions.

Current archive limits are 8 GiB of expanded event/attachment data, 16 MiB of manifest data, 100,000 listed files, 1 MiB per event line and 64 MiB per attachment. ZIP entries with unsupported paths, duplicates, symlinks, executable permissions, encryption, incompatible versions or mismatched hashes/sizes are rejected. The server admits up to two concurrent imports and two concurrent exports. These are implementation limits, not measured large-archive throughput claims.

## Moving a recording to another server

`migrate-recording` transfers an ended recording that a local binding published to a different server using only its committed history, so the native transcript is not needed:

```sh
agentlive finish --stream <recording-id>
agentlive migrate-recording --source <binding-directory> --operation-id <unique-id> \
  --target-server https://new.example.com --target-owner-file <destination-owner.json> \
  --old-recording retain            # or: remove --confirm-removal
```

`status` shows the binding directory. The command requires every captured event to be delivered and the source recording to be ended at the binding's boundary. It persists an intent, exports a staged `.agentlive` archive into the binding directory, verifies the archive against the source boundary, and imports it into the destination as a private ended recording whose metadata records the source server, recording, revision and boundary (`archiveOrigin`). Only then does it apply the requested disposition to the source. Rerunning with the same operation ID after an interruption or a lost response reuses the staged archive and destination recording; a different destination or operation for the same binding is rejected. The destination recording is continued like any archive import (a new identity); the old binding is marked transferred and cannot publish again, and `retire` can set it aside. To re-convert history under a changed converter or filter policy instead, see [converter migrations](converter-migrations.md).

## Standalone package

Build and verify a standalone installation with Node 26:

```sh
npx --yes pnpm@12.3.4 package:verify
npm install --global ./dist/release/agentlive-0.1.0.tgz
agentlive --help
```

The build bundles AgentLive workspace code into one CLI and includes a shrinkwrap for its external runtime dependencies. Verification installs the tarball in a fresh temporary directory with install scripts disabled, starts its server, imports a recording, lists and replays it, retries the import, and checks shutdown. `node scripts/probe-claude-publish.mjs --package` additionally creates and resumes a real Claude session, then verifies its recording through the installed package. The tarball includes the prebuilt browser viewer. No npm release has been published yet.


Package builds use the reviewed dependency tree in `packaging/runtime-lock.json` and do not resolve new runtime versions. After intentionally changing runtime dependencies, run `npx --yes pnpm@12.3.4 package:lock` and review the lock diff. `package:verify` rebuilds with an unreachable registry and requires byte-identical tarballs before testing installation. Installing external dependencies still requires registry access or an existing npm cache.

## Docker deployment

Standalone container deployment is available through the root Dockerfile and Compose configuration. See [Docker deployment](deployment/README.md) for build/start commands, persistent storage, owner credentials, HTTPS proxy guidance and the scope of local validation.

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

A read-only native transport/restart probe is available:

```sh
node scripts/probe-codex-publish.mjs /path/to/archived-session.jsonl
```

Run an explicit integration test against the installed Claude CLI (creates a new synthetic session and resumes it through the native CLI):

```sh
node scripts/probe-claude-publish.mjs
```

The installed Kimi CLI integration test creates a synthetic session, discovers it through `kimi session list`, resumes it natively while publishing, and checks publisher restart:

```sh
node scripts/probe-kimi-publish.mjs
```

```sh
node scripts/probe-opencode-publish.mjs
```
