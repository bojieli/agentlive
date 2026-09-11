# AgentLive documentation

## Using AgentLive

- [Usage guide](usage.md): every command, publishing, managed launch, family capture, viewers and limits
- [Compatibility](compatibility.md): what each agent adapter captures and known gaps
- [Sample recording](sample/README.md): replay a synthetic session without a server or agent
- [Recording archives](recording-archives.md): the portable `.agentlive` format
- [Remote artifacts](remote-artifacts.md) and [artifact bundles](artifact-bundles.md)
- [OpenCode revert projection](opencode-revert.md)

## Operating a server

- [Deployment](../deployment/README.md): Docker/Compose and HTTPS reverse proxy
- [Server backups](server-backups.md): offline and online backup, restore, publisher recovery
- [Hosted identity](hosted-identity.md): OIDC login, device login, accounts, operator administration, revocation
- [Viewing credentials](viewing-credentials.md) and [publisher credentials](publisher-credentials.md)
- [Recording removal](recording-removal.md) and [abuse reports](abuse-reports.md)
- [Converter migrations](converter-migrations.md): inspecting and migrating bindings when conversion policy changes

## Internals and evidence

- [Protocol and storage notes](protocol/) and [design decisions](decisions/)
- [Adapter probes](adapters/LIVE_PROBES.md) and [native-history corpus](adapters/NATIVE_HISTORY_CORPUS.md)
- [Browser](browser/README.md), [terminal](terminal/README.md) and [performance](performance/README.md) evidence
- [History](history/): the verbatim implementation-status and remaining-work logs through 2026-09-11

Project status lives in [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) and [REMAINING_WORK.md](../REMAINING_WORK.md); the product contract is the [implementation plan](../IMPLEMENTATION_PLAN.md).
