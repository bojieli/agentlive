# Changelog

AgentLive has not made a versioned release yet. This file records notable user-visible changes on `main`.

## Unreleased

### Added

- `agentlive visibility --stream <id> [--visibility public|unlisted|private]` reads and changes a recording's visibility from the command line.
- The server reclaims superseded snapshot content automatically, keeping the current head, every unexpired lease and every pinned read; `serve --no-snapshot-collection` disables it.
- Live file publishing keeps a bounded, segmented journal instead of an ever-growing `capture.jsonl`, and captures durably before the recording exists, so a session started while the server is unreachable is recorded and delivered when it returns.
- `pnpm probe:release` rehearses the whole publish → watch → rewind → catch up → replay journey against the installed package.

- Publication control commands: `agentlive status`, `pause`, `resume`, `finish` and `reopen` operate on local publisher bindings without printing credentials or content; `agentlive retire` sets a finished binding aside so the next publish of that native session starts a new recording; `agentlive doctor` checks the runtime, credentials, server and installed agents.
- `serve` reports the viewer URLs that actually reach it and whether it is reachable only from this machine.
- `publish` output includes the recording's stable `viewerUrl`; `watch` and `replay` accept a viewer URL; the server redirects `/s/<id>` short links.
- Operator account administration for hosted mode: `agentlive accounts` and `agentlive account-status` (`GET /api/v1/admin/accounts`, `POST /api/v1/admin/accounts/:id/status`); disabling ends the account's sessions, transfers and sockets immediately.
- Server data directories record a format version; servers and `restore` refuse data written by a newer format, making rollback by restoring a pre-upgrade backup safe.
- Server-wide storage limits (`serve --max-stored-bytes`, `--min-free-bytes`) enforced for every writer including the local owner, with `/readyz` reporting not-ready below the free-space floor.
- Optional operational metrics: `serve --metrics` exposes an owner- or token-authenticated Prometheus `GET /metrics` with content-free aggregates only.
- Per-account quotas for hosted mode (`quotas` in the hosted config): recording, open-recording and stored-byte limits enforced with a non-retryable `quota_exceeded` error; usage at `GET /api/v1/account/usage` and in the operator account listing.
- `agentlive migrate-live` also migrates OpenCode bindings, freezing a fresh native export as the source, and `--abandon` releases a migration that can never complete; a concurrent `import` is fenced like `publish`.
- `agentlive migrate-live` replaces a live Claude, Codex or Kimi binding with a private recording re-converted from retained native history under new filter/title/artifact options, with lineage and an explicit retain/remove disposition; `publish` accepts `--redact-env`.
- Online server backup: `agentlive backup --server <origin> --output <dir>` and owner-only `POST /api/v1/admin/backup` back up a running server in the restore-compatible format.
- In-flight private HTTP transfers are aborted when their authorizing session, device, grant or publisher credential is revoked, when an account is disabled, or when the recording becomes private or is removed. Open viewing sockets close immediately on the same changes.
- `capture.completeness` notices for recordings imported from unfinished native sessions, counting unfinished messages and tools, running tasks, pending interactions and pending attachments; shown by the browser and terminal viewers and carried in `.agentlive` provenance.
- Portable `.agentlive` export, offline replay and import; artifact bundles and authenticated remote artifacts for all four agents; hosted OIDC/device login, sharing grants, public discovery, removal and abuse reports; Docker/Compose deployment; offline backup/restore and publisher recovery; family (parent/subagent) capture, import and continuation for all four agents; managed launch; paged, cached browser and terminal playback.
- A synthetic sample recording in `docs/sample` that replays without a server or agent.

### Fixed

- Archive imports and exports stage inside the server directory instead of the system temporary directory, and an upload is bounded by the owner's remaining storage quota, so staging bytes can no longer escape every limit.

- `agentlive watch` finishes on its own once an ended recording has been shown, instead of waiting forever; `--follow` keeps waiting for a reopen, and `q` now quits a non-interactive watch in a terminal.

- Disabling a hosted account now suspends its recordings in both directions: publishing is refused, publisher sockets close, and reads and the public listing exclude them until the account is enabled again (the operator credential can still review them).
- Secret redaction now decides from the captured bytes: anything that decodes as UTF-8 is redacted as text, and anything else is scanned for each secret's literal byte sequence. Previously a file extension or a transcript-supplied media type decided, so a secret in a `.py`, `.sh`, `.env` or extension-less file, or in content declared `application/octet-stream`, was stored and served verbatim.
- `recover-publisher` works against a pruned journal; previously it replayed from sequence zero and would have failed on any publisher that had compacted.
- A failed online-backup cleanup no longer wedges every later backup or leaves the plaintext owner credential in the partial output.

- Long uncached browser playback no longer fails at the memory store's entry quota: generational collection, cheaper validation and compact blob storage let a 500,000-event recording play back under default limits.
- Kimi histories whose tool results contain a single content-part object (Kimi 1.5 image outputs) no longer fail conversion.
- `agentlive replay` no longer crashes with an unhandled EPIPE when its output pipe is closed (for example `| head`).

### Changed

- The standalone package is named `agentlive` and licensed under MIT.
- Documentation reorganized: a concise README, a detailed [usage guide](docs/usage.md), a [compatibility matrix](docs/compatibility.md), [published limits and measured performance](docs/limits.md), and contribution and security policies. Historical status logs moved to `docs/history/`, and `pnpm check` now validates every documentation link.
- A tag-triggered release workflow builds a publishable manifest (`build-package.mjs --release`) and publishes `agentlive` to npm with provenance; see [RELEASING.md](RELEASING.md).
- The platform statement now rests on evidence: a manually triggered Windows probe workflow records exactly what works there and what does not.
