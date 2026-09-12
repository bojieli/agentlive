# Releasing AgentLive

AgentLive has not been released yet. This checklist is the intended path for the first and later releases. The exit gates in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) decide *whether* a release should be called production-ready; this document covers *how* to cut one.

## Before tagging

1. `main` is green in CI on Linux and macOS (`check` and `package:verify`).
2. Run the local evidence that CI does not cover and record results in `IMPLEMENTATION_STATUS.md`:
   - `node scripts/probe-browser.mjs` (rendered Chrome checks)
   - `docker build -t agentlive:production-gate-local . && node scripts/probe-container.mjs`
   - Opt-in native probes for each agent you advertise (they use real agents and may incur provider charges): see the [usage guide](docs/usage.md#live-integration-probes).
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

## Publish

The npm package is named `agentlive`. Ordinary builds keep `private: true` so a stray `npm publish` fails; only `node scripts/build-package.mjs --release` emits a publishable manifest.

1. One-time setup: create the `npm` environment in the GitHub repository with an `NPM_TOKEN` secret (an npm automation token for the `agentlive` package), and require reviewers on that environment if desired.
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. The [release workflow](.github/workflows/release.yml) reruns `check` and `package:verify`, verifies the tag matches the package version, builds the release tarball and runs `npm publish --provenance --access public`, so npm shows a signed provenance statement linking the package to the workflow run.
4. Create GitHub release notes from the changelog entry, and attach the tarball if desired.

## After publishing

- Verify a clean install: `npm install --global agentlive@<version> && agentlive doctor`.
- Update the README quick start to use the registry package instead of building from source.
- Container images are not published by the workflow yet; build them from the tagged commit as described in [deployment](deployment/README.md).
