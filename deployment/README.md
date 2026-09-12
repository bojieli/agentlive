# Standalone Docker deployment

This deployment runs the standalone server with a single owner credential. The same image can enable hosted OIDC accounts with `serve --hosted-config` (see [hosted identity](../docs/hosted-identity.md)); production capacity acceptance and a deployed pilot remain open release gates.

## Build and start

Use Node 26.8.1 and pnpm 12.3.4 on the build machine, plus Docker Engine and Compose v2:

```sh
pnpm install --frozen-lockfile
pnpm package:build
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:7331/readyz
```

Open `http://127.0.0.1:7331`. The base image is pinned by version and multi-platform manifest digest; update that digest deliberately when upgrading Node. The image uses the staged release in `dist/package`, with runtime dependencies installed from its shrinkwrap and install scripts disabled. `.dockerignore` admits only staged runtime files; native sessions, credentials and development directories do not enter the image context. Rebuild the staged package before building a changed image.

The server runs as UID 1000, with a read-only root filesystem, a 256 MiB temporary filesystem and a named volume mounted at `/data`. The volume stores `/data/owner.json` and `/data/server`; the server generates the owner credential on first startup with owner-only permissions. Do not delete or share that file. Avoid multiple server containers mounting the same data directory. A bind mount can replace the named volume, but its directory must be writable by UID 1000.

Compose publishes port 7331 only on the host loopback interface. The server listens on all interfaces _inside_ the container so Docker forwarding works. `/readyz` checks storage readiness; `/healthz` only confirms the HTTP process is responding. Docker's health status does not restart an unhealthy but still-running container; configure monitoring separately.

## Use the server from a publisher machine

Copy the generated credential into a private local file without printing it in the terminal:

```sh
mkdir -p "$HOME/.agentlive-container"
chmod 700 "$HOME/.agentlive-container"
(umask 077; docker compose exec -T agentlive cat /data/owner.json > "$HOME/.agentlive-container/owner.json")
agentlive list --server http://127.0.0.1:7331 --owner-file "$HOME/.agentlive-container/owner.json"
```

Use that `--server` and `--owner-file` with normal import/publish commands. The owner credential grants full control of the server. Share individual recordings with scoped, revocable [viewing grants](../docs/viewing-credentials.md) instead of the owner credential. Native agents run on publisher machines, not inside the server image.

## HTTPS and reverse proxy

Remote viewers and publishers reach the server through a TLS reverse proxy, never over the loopback port directly. [`compose.https.yaml`](compose.https.yaml) is that deployment: it removes the server's host port entirely, puts Caddy in front on the private Compose network, and starts the server with `--public-origin`. Run it from the repository root:

```sh
pnpm package:build
export AGENTLIVE_PUBLIC_HOST=recordings.example.com
export AGENTLIVE_PUBLIC_ORIGIN=https://recordings.example.com
docker compose -f compose.yaml -f deployment/compose.https.yaml up --build -d
```

The overlay carries the Caddyfile inline, so nothing else has to be copied to the host:

```caddyfile
recordings.example.com {
    tls internal    # a real deployment drops this line and lets ACME issue
    reverse_proxy agentlive:7331 {
        flush_interval -1
        header_up X-Forwarded-Host {host}
    }
    header {
        Strict-Transport-Security "max-age=31536000"
    }
}
```

For a real name, drop `tls internal` and the `auto_https disable_redirects` line from the global block so Caddy obtains and renews a public certificate, and make sure ports 80 and 443 reach the proxy.

### `--public-origin` is required, not optional

The server compares the browser's `Origin` header against the origin it believes it is served at, and rejects a mismatch with `403 Origin is not allowed`. Bound inside a container it believes that origin is `http://0.0.0.0:7331`, so **behind any reverse proxy at an HTTPS name, every browser request that carries an `Origin` is refused** — including the viewer's `/api/v1/watch` WebSocket upgrade, which browsers always send an `Origin` on. The viewer cannot watch anything at all. Reproduce it by starting the server without the flag and asking for the origin it is actually served at:

```sh
curl -sS --cacert root.crt -o /dev/null -w '%{http_code}\n' \
  -H 'Origin: https://recordings.example.com' https://recordings.example.com/readyz
# 403 without --public-origin, 200 with it
```

`serve --public-origin https://recordings.example.com` fixes it, takes a bare origin (scheme, host and optional port, no path), conflicts with `--hosted-config` (which already carries one), and also makes the startup `ready` line report the truth: `viewerUrls: ["https://recordings.example.com/"]` and `reachability: "public-origin"` instead of the container address. Publisher-side viewer URLs come from the client's own `--server`, so publish and import with `--server https://recordings.example.com` and the reported viewer URL is the HTTPS one.

### Proxy settings that turned out to matter

- **WebSocket upgrades.** Caddy forwards `Connection`/`Upgrade` with no configuration. Nothing else was needed for publishing or watching.
- **Buffering.** `flush_interval -1` disables response buffering so live frames and attachment bytes leave the proxy as they arrive; a 5 MiB attachment came through in 326 chunks with `Content-Length` intact.
- **Timeouts.** `servers { timeouts { idle 20s } }` is safe: `idle` governs keep-alive between HTTP requests and does not touch a hijacked WebSocket. Leave `write` unset — it is a whole-response deadline and would cut a large attachment download on a slow link. (Measured on Caddy 2.11.4, `write 10s` did _not_ cut a 50-second WebSocket; Caddy clears deadlines on hijack. The download risk is the reason to leave it off.)
- **Client heartbeats are the protocol's, not the proxy's.** The server closes any socket that has sent nothing for 60 seconds (`1001 Heartbeat timeout`); the real publisher and subscriber send a heartbeat every 20 seconds. A quiet viewer stays alive because of that, not because of proxy configuration.
- **No `encode`.** Compression is not needed here and would put a rewriting layer in front of every response; if you add it, keep it off the attachment routes.
- **Headers.** Caddy passes `Authorization`, `Content-Type` and every response security header through unchanged. Add `Strict-Transport-Security` at the proxy. Do **not** add a `Content-Security-Policy` there: the server sends three different deliberate policies (the viewer, `/artifact-preview`, `/artifact-interactive`) and a proxy-wide one would flatten them. Do not log authorization headers, cookies or request bodies.
- **Capabilities.** The Caddy binary carries `cap_net_bind_service` as a file capability, so `cap_drop: ALL` alone makes even `exec` fail; the overlay keeps exactly that one capability.
- **Resolving the name.** The proxy joins the Compose network under its public name as an alias, so a publisher container reaches `https://recordings.example.com` with no host DNS at all. The probe's host-side clients resolve the same name to loopback with a per-connection `lookup`, keeping the real name in SNI, in `Host` and in the certificate check.

### What the rehearsal covers

`node scripts/probe-https.mjs` brings up this exact overlay in its own Compose project, with Caddy's internal CA issuing a certificate for `recordings.agentlive.test`, and verifies everything over HTTPS with certificate verification on against that generated CA (never `NODE_TLS_REJECT_UNAUTHORIZED=0`). It removes every container, volume, network and temporary file on success and on failure, prints one JSON summary line, exits non-zero on any failure and writes `probe-results/https/report.json`. A passing run is recorded in the [2026-09-12 report](https-probe-2026-09-12.json). It takes about 80 seconds once the image is built (65 of those are a deliberate wait), and roughly four minutes including a cold `--build`.

| Check                                              | What it establishes                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy-terminates-tls-for-public-name`             | `/readyz` over HTTPS, chain verified against the generated root alone, name checked against SNI, `Via: 1.1 Caddy`                                              |
| `server-reachable-only-through-proxy`              | the server container publishes no host port                                                                                                                    |
| `viewer-and-assets-survive-proxying`               | viewer HTML, `app.js`, `app.css`, favicon and both artifact preview routes are byte-identical to what the server serves inside the container                   |
| `security-headers-and-csps-unchanged`              | all three CSPs, `Referrer-Policy`, `Cache-Control` and `X-Content-Type-Options` match the in-container values; the three policies stay distinct; HSTS is added |
| `browser-origin-accepted-at-public-origin`         | the public origin is accepted on HTTP and on a WebSocket upgrade; a foreign origin is still 403                                                                |
| `private-import-and-replay-through-proxy`          | a publisher container imports and replays through the proxy, and `status` reports the HTTPS viewer URL                                                         |
| `private-recording-stays-private-through-proxy`    | an unauthenticated reader is refused; the owner reads `visibility: private`                                                                                    |
| `websocket-publisher-and-viewer-concurrently`      | a live publisher and a viewer on the proxy at the same time; events arrive in producer order                                                                   |
| `quiet-viewer-outlives-proxy-idle-timeout`         | a viewer sending no application traffic for 65 s, against the 20 s proxy idle timeout, keeps receiving heartbeats and then a live event                        |
| `attachment-streams-through-proxy`                 | a 5 MiB attachment uploads and downloads with an unchanged digest, `Content-Length` and no `Content-Encoding`, delivered progressively                         |
| `short-link-and-public-viewer-url`                 | `/s/<id>` redirects with `Referrer-Policy: no-referrer`, the target loads, and the startup `ready` line names the public origin                                |
| `publisher-and-viewer-recover-from-proxy-restart`  | both reconnect after `docker compose restart caddy`                                                                                                            |
| `publisher-and-viewer-recover-from-server-restart` | both reconnect after `docker compose restart agentlive`                                                                                                        |
| `no-events-lost-or-duplicated-across-restarts`     | live delivery and durable history both hold exactly the published events, once each, in order                                                                  |

A reconnecting viewer must page `/api/v1/streams/<id>/events` from its cursor up to the boundary the `subscribed` frame reports: a subscription delivers only events after that boundary, so a client that merely resubscribes silently loses everything published while it was disconnected. That is protocol behaviour, not proxy behaviour, but it is the failure a proxy restart exposes first.

### What this does not establish

The certificate comes from Caddy's local CA, not a public one: no ACME issuance, renewal or OCSP path has run. The hostname is resolved by a Compose network alias and by a per-connection `lookup`, not by public DNS. Everything runs on one machine over loopback, so no real network latency, packet loss, MTU, corporate middlebox or CDN is involved, and the concurrency is one publisher and one viewer rather than a capacity test. No remote host, no `systemd`, no host firewall and no monitoring integration are exercised, and HTTP/3 is available in the proxy but unused by these clients. `/metrics` is not exercised behind the proxy. Actual DNS/TLS/remote-host acceptance remains an open release gate.

## Monitoring and storage limits

Add `--max-stored-bytes` and `--min-free-bytes` to the container command to bound what the server stores and to stop durable growth before the volume fills; `/readyz` reports not-ready while the free-space floor is breached. See [storage limits and metrics](../docs/operating.md#storage-limits-and-metrics) for the exact semantics.

`--metrics` enables `GET /metrics` in the Prometheus text format. Scrapes must present the owner credential or `AGENTLIVE_METRICS_TOKEN`; set that variable in the container environment and give it to the scraper rather than sharing the owner credential:

```yaml
environment:
  AGENTLIVE_METRICS_TOKEN: ${AGENTLIVE_METRICS_TOKEN:?set a random 32+ character token}
command:
  [
    "serve",
    "--host",
    "0.0.0.0",
    "--port",
    "7331",
    "--state-dir",
    "/data",
    "--metrics",
  ]
```

Do not expose `/metrics` publicly. Keep the published port on loopback as configured here and let the scraper reach it over the private network, or block `/metrics` at the reverse proxy for anything but your monitoring source. The endpoint exports aggregates only — no recording IDs, titles, account IDs, credentials or event content — and the container probe does not yet exercise it.

## Publish through a Cloudflare Tunnel

A tunnel is often the easiest way to put AgentLive on a real name: `cloudflared` dials out, so no inbound port is opened, nothing already listening on 80 or 443 is disturbed, no firewall rule changes, and Cloudflare issues and renews the certificate.

**Understand the trade-off first.** Cloudflare terminates TLS at its edge, so it can see everything passing through: recording content, attachment bytes and the access keys viewers present. AgentLive records coding sessions, which routinely contain source code and sometimes secrets. For a public demo recording that is fine. For private sessions, prefer a reverse proxy you run yourself ([above](#https-and-reverse-proxy)), where TLS terminates on your own host.

Create the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared). Add a public hostname routing to `http://agentlive:7331`. The dashboard gives you a **tunnel token**, which authorizes running that one tunnel and nothing else — prefer it to an account API token. Then, on the host:

```sh
export AGENTLIVE_PUBLIC_ORIGIN=https://agentlive.example.com
read -rs CLOUDFLARE_TUNNEL_TOKEN && export CLOUDFLARE_TUNNEL_TOKEN   # not in shell history
docker compose -p agentlive -f compose.yaml -f deployment/compose.cloudflared.yaml up -d
```

`--public-origin` is required: the server checks a browser's `Origin` against the origin it believes it serves, and behind a tunnel that is the public name, not the container's address. Without it every WebSocket upgrade is refused and the viewer cannot watch anything.

Known limits of this path:

- Cloudflare's proxy caps request bodies (100 MB on the free plan), so archive **imports** larger than that fail through the tunnel even though the server accepts up to 9 GiB. Import large archives over a direct connection or an SSH tunnel. Downloads and exports are not affected.
- WebSockets must be enabled for the zone (they are by default). AgentLive's viewers heartbeat every 20 seconds, which keeps a paused viewer's connection alive through the edge's idle timeout.
- The tunnel token is a credential: keep it out of shell history and committed files, and revoke it in the dashboard when the deployment ends.

## Stop, replace and preserve data

```sh
docker compose stop
# Build the desired version and its staged package before replacing the image.
docker compose up --build -d
```

Compose grants 45 seconds for shutdown, exceeding the server's default 30-second drain timeout. The Node CLI receives SIGTERM directly as PID 1 and returns its documented signal exit code 143 after draining. The container probe checks that code and then verifies volume reopening. Named volumes persist across container replacement and ordinary `docker compose down`; `down -v` destroys them. Preserve an independently verified backup before upgrading recording formats. Portable `.agentlive` exports preserve recordings and attachments, but are not a backup of owner credentials or operational metadata. The [backup/restore commands](../docs/server-backups.md) support restoration into a new state directory with fresh revisions. For a running container, `docker compose exec agentlive node /opt/agentlive/cli.mjs backup --server http://127.0.0.1:7331 --state-dir /data --output /data-backups/<name>` writes an online backup inside the container, so mount a separate writable backup volume at that path (the root filesystem is read-only). The container probe exercises online backup inside the container (writing under `/data`, outside the server directory) and restores it; see the [2026-09-11 report](container-probe-2026-09-11.json). The data directory records its format version; an image refuses to start on data written by a newer format, so roll back by restoring a pre-upgrade backup with the older image (see [data format versions](../docs/server-backups.md#data-format-versions-upgrades-and-rollback)). Automated rollback orchestration remains unfinished.

## Local verification

```sh
docker compose config --quiet
docker compose -f compose.yaml -f deployment/compose.https.yaml config --quiet
docker build -t agentlive:production-gate-local .
node scripts/probe-container.mjs
node scripts/probe-https.mjs
```

The probe creates and removes its own container and named volume, tests non-root/read-only startup, health and preview assets, private import/replay, graceful termination, container replacement, credential persistence, archive export/offline replay, `doctor`, online backup while serving and offline backup, with both backups restored and replayed. It leaves the built image available and writes `probe-results/container/report.json`. `probe-https.mjs` is the reverse-proxy rehearsal described under [HTTPS and reverse proxy](#https-and-reverse-proxy); it needs port 443 free on loopback (`AGENTLIVE_HTTPS_PORT` moves it) and a staged package from `pnpm package:build`. Both are small correctness fixtures, not a capacity benchmark or deployed pilot.

## Offline container backup and restore

Prepare a host backup directory writable by the container's UID 1000. Stop the service before copying its operational state:

```sh
docker compose stop agentlive
docker compose run --rm -v /srv/agentlive-backups:/backups agentlive backup --state-dir /data --output /backups/backup-2026-09-10
docker compose start agentlive
```

Choose a new output name for each backup. The mounted host backup directory is independent of the recording volume; copying into the same volume, as the disposable verification probe does, is not protection against volume loss.

Restore to a fresh named volume, keeping the original deployment available for rollback. Replace `agentlive:local` with the compatible image you built or retained:

```sh
docker volume create agentlive-restored
docker run --rm --mount type=volume,src=agentlive-restored,dst=/data --mount type=bind,src=/srv/agentlive-backups,dst=/backups,readonly agentlive:local restore --source /backups/backup-2026-09-10 --output /data/state
```

Start the restored server on a separate loopback port for verification:

```sh
docker run -d --name agentlive-restored --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=256m --mount type=volume,src=agentlive-restored,dst=/data -p 127.0.0.1:7332:7331 agentlive:local serve --host 0.0.0.0 --port 7331 --state-dir /data/state
curl --fail http://127.0.0.1:7332/readyz
```

The restored owner credential is `/data/state/owner.json`. Test access and recording content before switching a reverse proxy or publisher origin to this server. Existing publisher bindings expect the original origin and require the explicit [publisher recovery procedure](../docs/server-backups.md#recover-an-existing-publisher-after-restore) after cutover. This example creates containers only; it does not change DNS or a proxy automatically. Stop with `docker stop -t 45 agentlive-restored`.

The [container administration report](container-admin-probe-2026-09-10.json) adds running-server backup refusal, offline backup/restore and exact restored replay with fresh revisions to the earlier eight container checks. The probe uses disposable data on Docker Desktop's Linux engine. Actual-host disaster recovery, multi-machine cutover and infrastructure loss remain acceptance work.
