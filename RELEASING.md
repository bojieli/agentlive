# Releasing AgentLive

AgentLive has not been released yet. This checklist is the intended path for the first and later releases. The exit gates in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) decide *whether* a release should be called production-ready; this document covers *how* to cut one.

## Before tagging

1. `main` is green in CI on Linux and macOS (`check` and `package:verify`).
2. Run the local evidence that CI does not cover and record results in `IMPLEMENTATION_STATUS.md`:
   - `node scripts/probe-browser.mjs` (rendered Chrome checks)
   - `docker build -t agentlive:production-gate-local . && node scripts/probe-container.mjs`
   - Opt-in native probes for each agent you advertise (they use real agents and may incur provider charges): see the [usage guide](docs/usage.md#live-integration-probes).
3. Update [compatibility](docs/compatibility.md) with the native versions actually exercised.
4. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under the new version and date.
5. Set the version in `packages/cli/package.json`, then run `npx --yes pnpm@12.3.4 package:lock` so `packaging/runtime-lock.json` matches, and review the lock diff.
6. If the sample recording format changed, regenerate it with `node scripts/build-sample-recording.mjs` after `pnpm build`.

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
