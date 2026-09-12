# Installing AgentLive

AgentLive is one Node process. It needs no database, no message broker, and no model credentials of its own.

**Requirements:** Node.js 26.8.1 or newer within Node 26, on Linux or macOS ([Windows is not supported](compatibility.md#platforms)). Building from source additionally needs pnpm 12.3.4. Publishing a session needs the coding agent itself installed, with its own credentials.

No npm release has been published yet, so install from a build of this repository:

## Standalone package

Build and verify a standalone installation with Node 26:

```sh
npx --yes pnpm@12.3.4 package:verify
npm install --global ./dist/release/agentlive-0.1.0.tgz
agentlive --help
```

The build bundles AgentLive workspace code into one CLI and includes a shrinkwrap for its external runtime dependencies. Verification installs the tarball in a fresh temporary directory with install scripts disabled, starts its server, imports a recording, lists and replays it, retries the import, and checks shutdown. `node scripts/probe-claude-publish.mjs --package` additionally creates and resumes a real Claude session, then verifies its recording through the installed package. The tarball includes the prebuilt browser viewer. No npm release has been published yet.

Package builds use the reviewed dependency tree in `packaging/runtime-lock.json` and do not resolve new runtime versions. After intentionally changing runtime dependencies, run `npx --yes pnpm@12.3.4 package:lock` and review the lock diff. `package:verify` rebuilds with an unreachable registry and requires byte-identical tarballs before testing installation. Installing external dependencies still requires registry access or an existing npm cache.
