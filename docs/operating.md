# Running a server

Operating an AgentLive server: starting it, bounding what it stores, watching it, and putting it on a network. For container deployment see [deployment](../deployment/README.md); for backups see [server backups](server-backups.md).

## Server

After installing and building the workspace:

```sh
npx --yes pnpm@12.3.4 build
agentlive serve
```

The server listens on `127.0.0.1:7331` and persists state under `~/.agentlive`. First startup creates an owner-only credential file at `~/.agentlive/owner.json`; subsequent starts reuse it. The ready message reports the bound URL, the `viewerUrls` that actually reach it (with `--host 0.0.0.0`, the loopback address plus each non-internal interface address) and a `reachability` of `this-machine`, `network` or `public-origin`.

Behind a reverse proxy, pass `serve --public-origin https://recordings.example.com`: the server checks the browser's `Origin` against the origin it believes it serves, so without it every WebSocket upgrade from the proxied name is refused and the viewer cannot watch anything. With it, the ready message reports the public viewer URL rather than the address it is bound to. See [deployment](../deployment/README.md) for the proxy settings this needs. A loopback server is never described as reachable by others; remote viewers need `--host` behind an HTTPS reverse proxy ([deployment](../deployment/README.md)) or a tunnel. `/healthz` reports process liveness. `/readyz` returns 200 only when the recording root and sessions directory are accessible and the filesystem reports available blocks; otherwise it returns 503 with `{ "ready": false }`. Storage checks share one in-flight probe and a one-second response deadline. Readiness is an admission signal, not a guarantee that a subsequent write/fsync will succeed. Stop with Ctrl-C or SIGTERM to close storage cleanly.

For multi-session hosting, `serve --max-cached-sessions 128` sets the resident session cache capacity. Active requests and live connections retain their sessions; idle sessions can be evicted and reopened from JSONL. If every cached session is in use, new session loads receive a retryable capacity response. This limits resident session count, not total memory or retained disk usage. Programmatic `RecordingStore.get/create` calls acquire ownership and must be paired with `store.release(session)` when finished.

Server shutdown stops admission and drains accepted work. Configure its waiting deadline with `agentlive serve --shutdown-timeout-ms 30000` (default: 30 seconds; positive integer up to 2147483647). If the deadline expires, the CLI reports an error and cleanup continues while retaining the store lock. The library’s `close()` rejects with `ShutdownTimeoutError` (`code: "shutdown_timeout"`); use `whenClosed()` to await actual completion afterward. A timeout does not prove a pending write was canceled. Use a process supervisor for a hard termination deadline, including blocked event loops. On restart, publishers reconcile durable acknowledgements and retry unacknowledged events through the existing deduplication protocol.

Discover recordings hosted by your server with `agentlive list --server http://127.0.0.1:7331`. The command uses your owner credential and returns a JSON page with recording summaries and `nextAfter`. Continue with `--after <nextAfter>`; `--limit` accepts 1–100 and defaults to 50. Publisher credentials and anonymous access cannot list the server’s recordings. Pages are ordered by recording ID, and refreshing from the first page discovers recordings added before your current cursor.

## Storage limits and metrics

`serve --max-stored-bytes <n>` caps the total bytes the server stores across every recording — committed event logs plus installed attachments — for all writers, including the local owner. It is checked together with the [per-account quotas](hosted-identity.md#per-account-quotas): each durable write reserves its size before it starts, so concurrent creates, uploads, imports and publisher batches cannot jointly exceed a limit. An over-limit write fails with the non-retryable `quota_exceeded` error (HTTP 403, or a WebSocket error for publisher batches) whose details say whether the `global` or the account limit was hit; publishers and uploads stop rather than retry. Removing a recording frees its bytes, and usage is recomputed at startup. Ending a recording is never refused.

`serve --min-free-bytes <n>` additionally refuses durable growth when the filesystem reports less than that much available space, and makes `/readyz` report not-ready while the floor is breached. Admission is synchronous while `statfs` is not, so the floor uses a briefly cached sample minus the growth and pending reservations since that sample; only one probe is in flight at a time and waiters are released on a deadline. Reads, history downloads and recording removal continue below the floor.

Archive imports and exports stage their bytes under `<state-dir>/server/staging`, on the same filesystem the free-space floor measures, and an upload is refused once it exceeds what the owner could still be admitted to store. Staging is cleared at startup and excluded from backups.

The server also reclaims superseded snapshot content automatically: a pass keeps the current head, every unexpired lease and every pinned read, prunes the catalog to exactly those, and sweeps the rest. It is scheduled on measured growth (64 MiB since that recording's last pass) on the same single worker as snapshot builds, and `serve --no-snapshot-collection` disables it. Older checkpoints stop being selectable once a pass runs, so a viewer that must keep reading one exact checkpoint holds a lease on it; the browser and terminal viewers already do. See [snapshots](protocol/SNAPSHOTS.md#automatic-collection-of-superseded-content).

Snapshot freshness is measured, not inferred from failures: `agentlive_snapshot_behind_events` and `agentlive_snapshot_behind_seconds` report the furthest a cached recording's newest built snapshot is behind it. Under saturation an automatic build can hit its 30-second deadline, halve its batch and fall further behind — the failure counter says a build failed, these say what that cost the recordings. A recording whose builds stopped for good (below) is excluded, because it is not merely behind.

An event the reducer can never apply — an append to a message or tool that never
started, a second start for one id — is accepted by the server (each such event is
valid protocol on its own) and only fails when the snapshot builder reaches it. That
failure would repeat on every retry, so the builder names the exact recorded event
instead, and the scheduler stops building that recording rather than looping. It is
reported three ways: `agentlive_snapshot_blocked_recordings` counts the cached
recordings in that state, the owner-authenticated
`GET /api/v1/streams/<id>/publisher-state` returns `snapshotBlocked` with the event's
sequence number and the reducer's code, and the scheduler's status carries the same
counts. Both surfaces are content-free. Live delivery, raw history download and export
are unaffected; paged playback stays at the last snapshot that built, so the recording
is readable but stops advancing in the paged viewers. The fix is on the publisher: the
event stream cannot be repaired in place, so republish the session under a new
recording.

Past its fan-out capacity the server stays correct but falls behind, and every socket
can sit under its own shedding limit while it does. `serve --overload-event-loop-delay-ms
<n>` (default 250) sets the mean event-loop delay above which the server calls itself
over capacity; 64 MiB queued across all socket send buffers does the same. In that
state `/readyz` answers 503 with `overloaded`, so a load balancer stops sending new
work, and a new **viewer** WebSocket is refused with `retry_later`. Existing viewers
keep their connections — dropping them would turn latency into a reconnect storm — and
publishers are never refused, because durable capture is the point of the recording.
The state holds for five seconds after the measurement recovers so admission does not
alternate. `agentlive_delivery_overloaded`, `agentlive_delivery_refused_total`,
`agentlive_event_loop_delay_seconds` and `agentlive_websocket_buffered_bytes` report it.

`serve --metrics` enables `GET /metrics` in the Prometheus text format. It is disabled by default and never anonymous: a scrape must present the owner credential, or the value of `AGENTLIVE_METRICS_TOKEN` if that variable is set when the server starts. The response contains only aggregates — uptime, process memory, recording counts, cached sessions, WebSocket connections by role, in-flight transfers/imports/exports, stored and reserved bytes with the configured limits, free-space state, account count and limits, quota rejections by quota and scope, snapshot scheduler state, backup and write-barrier state, and request counts by method, route template and status class. Labels come from fixed sets, so no recording ID, title, account ID, credential or event content appears. A regression test drives a server with a known secret and title and asserts neither reaches stdout, stderr or `/metrics`.

## Docker deployment

Standalone container deployment is available through the root Dockerfile and Compose configuration. See [Docker deployment](../deployment/README.md) for build/start commands, persistent storage, owner credentials, HTTPS proxy guidance and the scope of local validation.
