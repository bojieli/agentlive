# Troubleshooting

Start with `agentlive doctor`. It checks the Node version, the state directory and credential permissions, whether the server answers `/healthz` and `/readyz`, whether any local publisher needs attention, and which agents are on your `PATH`. It prints JSON and exits non-zero when something is actually wrong.

```sh
agentlive doctor --server http://127.0.0.1:7331
```

## The viewer says nothing is there

**Private recordings need an access key.** Paste the `secret` from `<state-dir>/owner.json`, or issue a scoped credential with `agentlive viewing-grant`. Keys are never put in share URLs, so a link alone is not enough by design.

**Behind a proxy or tunnel, the server must know its public name.** Without `serve --public-origin https://your.name`, the server compares the browser's `Origin` against the address it is bound to, refuses every WebSocket upgrade, and the viewer joins but never receives anything. See [operating](operating.md#server).

## `publish` will not start

| Message                                    | Meaning                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Publishing is paused`                     | The binding was paused. `agentlive resume --stream <id>`.                                                                                                                                                  |
| `finish operation` pending or complete     | This binding finished its recording. `agentlive reopen` to continue it, or `agentlive retire` to start a new recording from the same native session.                                                       |
| `Another process owns this data directory` | A publisher is already attached to that binding, or a stale process holds the lock. Stop it and retry.                                                                                                     |
| `conversion or sharing options changed`    | The title, visibility, filtering or artifact options differ from the ones this binding was created with. Use the originals, or migrate deliberately — see [converter migrations](converter-migrations.md). |
| `quota_exceeded`                           | A per-account or server-wide storage limit. Not retryable until usage drops; see [operating](operating.md#storage-limits-and-metrics).                                                                     |

`agentlive status` shows every local binding: which recording it publishes, whether a publisher is attached, how many events are captured but not yet delivered, and what is blocking it. It never prints credentials or recorded content.

## The agent is running but nothing is recorded

Check that AgentLive is bound to the session the agent is actually writing to: `agentlive discover --agent <agent>` lists the native sessions it can see, newest first. A session started before AgentLive attached is still captured — file adapters read the retained history from the beginning.

If the server was unreachable when you started, that is fine: capture is durable before the recording exists, and everything is delivered once the server comes back. `status` shows the pending count.

## `watch` seems to hang

An **ended** recording is fully shown and then `watch` exits on its own. If it keeps waiting, the recording is still open — that is the point. `--follow` keeps waiting after the end for a possible reopen; in a terminal, `q` quits.

While the server is unreachable, `watch` deliberately keeps waiting rather than declaring the end, because a cached prefix cannot rule out a reopen.

## Something in a recording should not be there

Stop sharing it first — `agentlive visibility --stream <id> --visibility private` — then remove it if needed with `agentlive remove`. Exported archives and copies others already downloaded cannot be recalled.

Redaction filters the values you name with `--redact-env NAME`, plus environment variables whose names look like secrets, from message text **and** from captured file bytes. It is exact-substring matching: a secret that appears base64-encoded, case-shifted, or split across lines survives. Limiting `--artifact-root` to directories you are willing to publish is the stronger control.

If you found a leak that filtering should have caught, please report it privately — [SECURITY.md](../SECURITY.md).

## The server refuses writes

`/readyz` returns 503 when the recording directory is unreachable or the filesystem is below the configured `--min-free-bytes` floor. Reads keep working; durable growth is refused until there is space. Check `agentlive doctor` and the host's free disk.

## Recovering after a restore

A restored server gives every recording a fresh revision, so publishers holding the old one are rejected with `revision_changed`. Run `agentlive recover-publisher --source <binding-directory>` on the publisher machine: it verifies the restored server's history against the local journal before changing anything. See [server backups](server-backups.md#recover-an-existing-publisher-after-restore).

## Still stuck

Known open gaps are listed in [implementation status](../IMPLEMENTATION_STATUS.md) and [remaining work](../REMAINING_WORK.md) — the problem may already be a documented limit. Otherwise please open an issue with the output of `agentlive doctor`, the command you ran, and what happened instead.
