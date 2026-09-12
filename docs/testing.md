# Trying AgentLive as a tester

Thank you for testing. The goal is the journey the release gate names: **publish → watch → rewind → catch up → replay**, in both deployment shapes. It takes about twenty minutes. Nothing here sends data anywhere except the server you run.

Please report anything that surprised you, not only what broke. Confusing output, a command you expected to exist, a moment you did not know what to do next — those are the findings that matter most at this stage.

## What you need

- macOS or Linux, and Node.js 26.8.1 or newer within Node 26. Windows is not supported ([why](compatibility.md#platforms)).
- At least one of Claude Code, Codex, Kimi Code or OpenCode installed, with its own credentials. AgentLive never needs model credentials of its own, and never sends your prompts to anyone.
- About 500 MB of free disk.

Everything below uses an isolated state directory (`--state-dir ~/agentlive-test`) so your real `~/.agentlive` is untouched, and you can delete it afterwards.

## 1. Install and check

```sh
git clone https://github.com/bojieli/agentlive.git
cd agentlive
npx --yes pnpm@12.3.4 install --frozen-lockfile
npx --yes pnpm@12.3.4 package:build
npm install --global ./dist/release/agentlive-0.1.0.tgz
agentlive doctor
```

`doctor` should report your Node version, credential permissions and which agents it found. **Report:** anything it says that you do not understand, or that is wrong about your machine.

## 2. Replay the sample, with no server and no agent

```sh
agentlive replay --source docs/sample/agentlive-sample.agentlive --interactive
```

Space pauses, `.` and `,` step one event, `[` and `]` seek thirty seconds, `0` returns to the start, `q` quits. **Report:** whether the controls did what you expected, and whether the output was readable.

## 3. Record a real session

Start a server in one terminal:

```sh
agentlive serve --state-dir ~/agentlive-test
```

It prints the URLs that actually reach it. In a second terminal, start a session under AgentLive — use whichever agent you have:

```sh
agentlive publish --agent claude --launch --cwd ~/some-project --state-dir ~/agentlive-test
# or: --agent codex / --agent kimi / --agent opencode
```

Your agent runs normally in that terminal. Give it a couple of minutes of real work — ask for something that makes it read files and run commands, so the recording has tools and file changes in it, not only chat.

The publisher prints a `publishing` line with a `viewerUrl`. **Report:** whether the agent behaved exactly as it does without AgentLive. It should.

## 4. Watch, rewind and catch up

While the agent is still working, open the `viewerUrl` in a browser. The recording is private, so paste the access key from `~/agentlive-test/owner.json` (the `secret` field).

Then, in a third terminal:

```sh
agentlive watch <viewer-url> --interactive --state-dir ~/agentlive-test
```

Try, in both the browser and the terminal: pause while the agent keeps working; rewind thirty seconds and read what happened; step back one event at a time; then catch up to live. **Report:** whether the recording matched what the agent actually did, whether anything was missing or out of order, and how it felt to rewind a session that was still running.

## 5. Finish, export and replay offline

```sh
agentlive status --state-dir ~/agentlive-test
agentlive finish --stream <id> --state-dir ~/agentlive-test
agentlive export --stream <id> --output session.agentlive --state-dir ~/agentlive-test
agentlive replay --source session.agentlive --speed 4
```

**Report:** whether the offline replay showed the same session, and whether the archive is something you would be willing to share with a colleague.

## 6. Share it

```sh
agentlive viewing-grant --stream <id> --expires-at 2030-01-01T00:00:00Z --state-dir ~/agentlive-test
# or make it readable without a credential:
agentlive visibility --stream <id> --visibility public --state-dir ~/agentlive-test
```

**Report:** whether you could tell who could see what, at each step. Privacy has to be obvious, not inferred.

## Please check for leaks

This matters more than any feature. Before sharing a recording anywhere, look at it as a viewer and check whether anything appears that should not: API keys, tokens, file contents from outside the project, paths you would rather not publish.

AgentLive filters values you name with `--redact-env NAME`, plus environment variables whose names look like secrets, from text **and** from captured file bytes. It is exact-substring matching, so a secret that appears base64-encoded, case-shifted or split across lines will survive. **Report any leak immediately** and privately — see [SECURITY.md](../SECURITY.md), not a public issue.

## When you are done

```sh
rm -rf ~/agentlive-test session.agentlive
npm uninstall --global agentlive
```

## What to send back

- Which agent and version, and your OS.
- Where you got stuck, confused, or surprised.
- Anything in a recording that should not have been there.
- Whether you would use this, and what would have to change first.

Known limits are in [limits](limits.md) and [compatibility](compatibility.md); open gates are in [implementation status](../IMPLEMENTATION_STATUS.md). If something there is already documented as unfinished, you do not need to report it — though telling us it mattered to you is useful.
