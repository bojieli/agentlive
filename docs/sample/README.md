# Sample recording

`agentlive-sample.agentlive` is a small portable recording of a synthetic Claude Code session (a failing test, an inline screenshot, tool calls and a fix). It contains no real transcript data and needs no server or agent:

```sh
agentlive replay --source docs/sample/agentlive-sample.agentlive --interactive --speed 2
agentlive import --source docs/sample/agentlive-sample.agentlive   # into a running server
```

It is generated through the real CLI (serve → import → export) by `node scripts/build-sample-recording.mjs` after `pnpm build`. The offline suite replays it, so an archive-format change that breaks existing recordings fails CI. Regenerating it produces new recording identifiers and timestamps in the manifest; the replayed content stays the same.
