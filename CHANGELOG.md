# Changelog

AgentLive has not made a versioned release yet. This file records notable user-visible changes on `main`.

## Unreleased

### Added

- Publication control commands: `agentlive status`, `pause`, `resume`, `finish` and `reopen` operate on local publisher bindings without printing credentials or content; `agentlive retire` sets a finished binding aside so the next publish of that native session starts a new recording; `agentlive doctor` checks the runtime, credentials, server and installed agents.
- `serve` reports the viewer URLs that actually reach it and whether it is reachable only from this machine.
- `publish` output includes the recording's stable `viewerUrl`; `watch` and `replay` accept a viewer URL; the server redirects `/s/<id>` short links.
- Operator account administration for hosted mode: `agentlive accounts` and `agentlive account-status` (`GET /api/v1/admin/accounts`, `POST /api/v1/admin/accounts/:id/status`); disabling ends the account's sessions, transfers and sockets immediately.
- Server data directories record a format version; servers and `restore` refuse data written by a newer format, making rollback by restoring a pre-upgrade backup safe.
- Online server backup: `agentlive backup --server <origin> --output <dir>` and owner-only `POST /api/v1/admin/backup` back up a running server in the restore-compatible format.
- In-flight private HTTP transfers are aborted when their authorizing session, device, grant or publisher credential is revoked, when an account is disabled, or when the recording becomes private or is removed. Open viewing sockets close immediately on the same changes.
- `capture.completeness` notices for recordings imported from unfinished native sessions, counting unfinished messages and tools, running tasks, pending interactions and pending attachments; shown by the browser and terminal viewers and carried in `.agentlive` provenance.
- Portable `.agentlive` export, offline replay and import; artifact bundles and authenticated remote artifacts for all four agents; hosted OIDC/device login, sharing grants, public discovery, removal and abuse reports; Docker/Compose deployment; offline backup/restore and publisher recovery; family (parent/subagent) capture, import and continuation for all four agents; managed launch; paged, cached browser and terminal playback.
- A synthetic sample recording in `docs/sample` that replays without a server or agent.

### Fixed

- `agentlive replay` no longer crashes with an unhandled EPIPE when its output pipe is closed (for example `| head`).

### Changed

- A tag-triggered release workflow builds a publishable manifest (`build-package.mjs --release`) and publishes `agentlive` to npm with provenance; see RELEASING.md.

- The standalone package is named `agentlive` and licensed under MIT.
- Documentation reorganized: concise README, detailed [usage guide](docs/usage.md), [compatibility matrix](docs/compatibility.md), contribution and security policies. Historical status logs moved to `docs/history/`.
