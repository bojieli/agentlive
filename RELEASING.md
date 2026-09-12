# Releasing AgentLive

`0.1.0` was published on 2026-09-12. This checklist is the path for that release and later ones. The exit gates in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) decide _whether_ a release should be called production-ready; this document covers _how_ to cut one.

## Before tagging

1. `main` is green in CI on Linux and macOS (`check` and `package:verify`).
2. Run the local evidence that CI does not cover and record results in `IMPLEMENTATION_STATUS.md`:
   - `node scripts/probe-browser.mjs` (rendered Chrome checks)
   - `docker build -t agentlive:production-gate-local . && node scripts/probe-container.mjs`
   - Opt-in native probes for each agent you advertise (they use real agents and may incur provider charges): see [CONTRIBUTING](CONTRIBUTING.md#live-integration-probes).
3. Run the release acceptance rehearsal (below) and record its report.
4. Update [compatibility](docs/compatibility.md) with the native versions actually exercised.
5. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under the new version and date.
6. Set the version in `packages/cli/package.json`, then run `npx --yes pnpm@12.3.4 package:lock` so `packaging/runtime-lock.json` matches, and review the lock diff.
7. If the sample recording format changed, regenerate it with `node scripts/build-sample-recording.mjs` after `pnpm build`.

### Release acceptance rehearsal

```sh
npx --yes pnpm@12.3.4 build
npx --yes pnpm@12.3.4 probe:release
```

`probe:release` runs `scripts/probe-release-flow.mjs`, which walks the journey the release gate names for external testers — **publish → watch → rewind → catch up → replay** — against the installed standalone tarball rather than workspace sources. It builds the package, installs it with `--ignore-scripts` into a temporary directory, starts `serve` on port 0 in an isolated state directory, publishes a live session from a synthetic `claude` executable on `PATH`, drives an interactive terminal viewer through a real pseudo-terminal (follow live, pause, step back, `[` to rewind 30 seconds, `l` to catch up through events published while paused, `q`), then finishes, exports and replays the archive offline and compares the text with what the viewer displayed. It also checks the browser viewer assets and `/s/<id>`, and rehearses the centralized shape: a scoped `viewing-grant` watched with `--viewer-file`, revocation, and anonymous access before and after the recording becomes public.

It takes about 20–40 seconds, makes no model calls and incurs no provider charges, needs no installed agent, never reads the operator's `~/.agentlive`, and uses only loopback plus the npm registry for the install step. It prints one JSON summary line with a named check list, exits non-zero on the first failure, and writes `probe-results/release-flow/report.json`. Every process, temporary directory and installed copy is removed on success and on failure.

Rendered browser behaviour stays with `scripts/probe-browser.mjs`; this probe only confirms the installed package serves the viewer. Two gaps it cannot close from the CLI: a recording's visibility can only be chosen at publish/import time (`--visibility`), and changing it later needs the browser viewer or the server API; and `agentlive watch` stays attached to an ended recording until the viewer quits, so the rehearsal interrupts it deliberately.

## External testing

Before a first public release, have testers who did not build this run the [testing guide](docs/testing.md) end to end on their own machines and agents, and collect what they report. The release gate asks for the publish → watch → rewind → catch up → replay journey completed in both deployment shapes; `pnpm probe:release` rehearses it automatically, but only people find the parts that are merely confusing.

## Publish

The npm package is named `agentlive`. Ordinary builds keep `private: true` so a stray `npm publish` fails; only `node scripts/build-package.mjs --release` emits a publishable manifest.

1. One-time setup, first release only. npm no longer accepts classic automation tokens for publishing ("Two-factor authentication or granular access token with bypass 2fa enabled is required"), and it cannot attach a trusted publisher to a package that does not exist yet — unlike PyPI, npm has no pending-publisher concept ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). So the first release of a new name is bootstrapped with a token: create a **granular access token** with read-and-write permission on **all packages** (a token scoped to one package cannot create that package), then create the `npm` environment in the GitHub repository with it as the `NPM_TOKEN` secret, and require reviewers on that environment if desired.
2. After the first release, switch to trusted publishing and stop using tokens entirely:

   ```sh
   npm trust github agentlive --file release.yml \
     --repo bojieli/agentlive --env npm --allow-publish
   gh secret delete NPM_TOKEN --env npm     # the workflow then uses OIDC
   npm token revoke <id>                    # from `npm token list`
   ```

   The release workflow needs no edit: it publishes with the token while the secret exists and with OIDC once it does not, and trusted publishing attests provenance by itself, so the `--provenance` flag is dropped on that path. Trusted publishing requires npm 11.5.1+ and Node 22.14.0+ (this repository pins Node 26.8.1) and the `id-token: write` permission the workflow already declares.
3. Tag and push: `git tag v<version> && git push origin v<version>`.
4. The [release workflow](.github/workflows/release.yml) reruns `check` and `package:verify`, verifies the tag matches the package version, builds the release tarball and publishes it, so npm shows a signed provenance statement linking the package to the workflow run. Provenance requires the repository to be **public**; npm refuses to generate it for a private one.
5. Create GitHub release notes from the changelog entry, and attach the tarball if desired.

## After publishing

- Verify a clean install: `npm install --global agentlive@<version> && agentlive doctor`.
- Update the README quick start to use the registry package instead of building from source.
- Container images are not published by the workflow yet; build them from the tagged commit as described in [deployment](deployment/README.md).
