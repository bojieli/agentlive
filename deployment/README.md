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

Compose publishes port 7331 only on the host loopback interface. The server listens on all interfaces *inside* the container so Docker forwarding works. `/readyz` checks storage readiness; `/healthz` only confirms the HTTP process is responding. Docker's health status does not restart an unhealthy but still-running container; configure monitoring separately.

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

For remote clients, place a TLS reverse proxy in front of the loopback port. For example, install Caddy on the same host, configure a DNS name pointing at that host, and use:

```caddyfile
recordings.example.com {
    reverse_proxy 127.0.0.1:7331
}
```

Caddy handles WebSocket upgrades. Keep request streaming enabled and avoid proxy response buffering or short timeouts on live WebSocket connections. Preserve Authorization, Content-Type and response security headers. The artifact preview routes intentionally have different CSPs; do not replace them with the main application CSP. Do not log authorization headers, cookies or request bodies. Use `https://recordings.example.com` as the publisher/viewer server origin. Actual DNS/TLS/remote-host acceptance is not established by the local container probe.

## Stop, replace and preserve data

```sh
docker compose stop
# Build the desired version and its staged package before replacing the image.
docker compose up --build -d
```

Compose grants 45 seconds for shutdown, exceeding the server's default 30-second drain timeout. The Node CLI receives SIGTERM directly as PID 1 and returns its documented signal exit code 143 after draining. The container probe checks that code and then verifies volume reopening. Named volumes persist across container replacement and ordinary `docker compose down`; `down -v` destroys them. Preserve an independently verified backup before upgrading recording formats. Portable `.agentlive` exports preserve recordings and attachments, but are not a backup of owner credentials or operational metadata. The [backup/restore commands](../docs/server-backups.md) support restoration into a new state directory with fresh revisions. For a running container, `docker compose exec agentlive node /opt/agentlive/cli.mjs backup --server http://127.0.0.1:7331 --state-dir /data --output /data-backups/<name>` writes an online backup inside the container, so mount a separate writable backup volume at that path (the root filesystem is read-only). The container probe does not yet exercise online backup. Recording-format migrations and automated rollback remain unfinished; do not assume an older image can read data changed by a newer format.

## Local verification

```sh
docker compose config --quiet
docker build -t agentlive:production-gate-local .
node scripts/probe-container.mjs
```

The probe creates and removes its own container and named volume, tests non-root/read-only startup, health and preview assets, private import/replay, graceful termination, container replacement, credential persistence and archive export/offline replay. It leaves the built image available and writes `probe-results/container/report.json`. This small correctness fixture is not a capacity benchmark or deployed pilot.

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
