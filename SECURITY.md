# Security policy

AgentLive handles coding-session transcripts, attachments and credentials. Please report vulnerabilities privately.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Do not open a public issue, and do not include real transcripts, credentials or other people's data in the report; a synthetic reproduction is enough. We aim to acknowledge reports within a week and will coordinate a fix and disclosure date with you.

AgentLive is pre-release software. Only the latest commit on `main` receives fixes until versioned releases exist.

## Scope

In scope, among others:

- Reading or modifying a private recording, attachment, snapshot or export without authorization, including after a credential, grant, session or device has been revoked.
- Secrets reaching recordings, archives, logs or error messages despite the documented filtering (known environment secrets, publisher/owner credentials, native server passwords, remote-artifact authorization values).
- A viewer causing actions on a publisher's machine. Viewing is spectator-only by design.
- Script execution or network access escaping the attachment and HTML/bundle preview sandboxes.
- Path traversal, symlink or special-file handling in imports, archives, artifact capture, backup and restore.
- Corruption or silent loss of acknowledged events, and cursor/revision confusion between clients.
- Hosted mode: OIDC/device login, CSRF, account isolation, public listing and abuse-report handling.

Out of scope: denial of service by an authenticated owner against their own server, issues requiring a compromised publisher machine, and vulnerabilities in the native agents themselves (report those upstream).

## Deployment guidance

- The owner credential (`<state-dir>/owner.json`) grants full control of a server. Keep it private (mode 600) and never place it in URLs, shell history or shared configuration.
- Expose a server beyond loopback only behind HTTPS; see [deployment](deployment/README.md). Do not log `Authorization` headers, cookies or request bodies at the proxy.
- Operational backups contain credentials and all recording contents; protect them like the data directory. Portable `.agentlive` exports contain recording content but no server credentials.
- Only restore backups and import archives from sources you trust: hashes establish integrity against their manifest, not the author's identity.
