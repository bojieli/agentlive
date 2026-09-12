import { expect, it } from "vitest";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rm,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile),
  cli = resolve("packages/cli/dist/main.js");
const env = { PATH: process.env.PATH ?? "" };
async function start(stateDir: string, port = "0") {
  const child = spawn(
    process.execPath,
    [cli, "serve", "--state-dir", stateDir, "--port", port],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostic = "";
  child.stderr!.on("data", (chunk) => (diagnostic += String(chunk)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const lines = createInterface({ input: child.stdout! });
  try {
    const ready = await new Promise<{ url: string; ownerFile: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server startup timed out")),
          10000,
        );
        lines.once("line", (line) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(error);
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Server exited before ready: " + diagnostic));
        });
      },
    );
    return { child, exited, ...ready };
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  } finally {
    lines.close();
  }
}
it("runs local serve/import across processes with private credentials and restart-safe storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-cli-test-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    expect((await stat(server.ownerFile)).mode & 0o777).toBe(0o600);
    const credential = await readFile(server.ownerFile, "utf8");
    const source = join(root, "source.jsonl");
    await writeFile(
      source,
      JSON.stringify({
        type: "user",
        sessionId: "cli_session",
        uuid: "row1",
        timestamp: "2026-09-01T00:00:00.000Z",
        message: { content: "CLI test message" },
      }) + "\n",
    );
    const discovered = JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, "discover", "--agent", "claude", "--source-root", root],
          { env, timeout: 30000 },
        )
      ).stdout,
    );
    expect(discovered.sessions).toHaveLength(1);
    expect(discovered.sessions[0].nativeSessionId).toBe("cli_session");
    const args = [
      cli,
      "import",
      "--agent",
      "claude",
      "--source",
      discovered.sessions[0].source,
      "--state-dir",
      root,
      "--server",
      server.url,
    ];
    const first = JSON.parse(
      (await exec(process.execPath, args, { env, timeout: 30000 })).stdout,
    );
    expect(first.event).toBe("imported");
    expect(first.visibility).toBe("private");
    const selected = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            cli,
            "import",
            "--agent",
            "claude",
            "--native-session",
            "cli_session",
            "--source-root",
            root,
            "--state-dir",
            root,
            "--server",
            server.url,
          ],
          { env, timeout: 30000 },
        )
      ).stdout,
    );
    expect(selected.streamId).toBe(first.streamId);
    const second = JSON.parse(
      (await exec(process.execPath, args, { env, timeout: 30000 })).stdout,
    );
    expect(second.streamId).toBe(first.streamId);
    expect(second.producerEvents).toBe(first.producerEvents);
    expect(
      (await fetch(`${server.url}/api/v1/streams/${first.streamId}`)).status,
    ).toBe(403);
    const replayArgs = [
      cli,
      "replay",
      "--stream",
      first.streamId,
      "--server",
      server.url,
      "--state-dir",
      root,
    ];
    const replay = await exec(process.execPath, replayArgs, {
      env,
      timeout: 30000,
    });
    expect(replay.stdout).toContain("CLI test message");
    expect(replay.stdout).toContain("Recording ended");
    const portable = join(root, "session.agentlive");
    await exec(
      process.execPath,
      [
        cli,
        "export",
        "--stream",
        first.streamId,
        "--server",
        server.url,
        "--output",
        portable,
        "--state-dir",
        root,
      ],
      { env, timeout: 30000 },
    );
    const offline = await exec(
      process.execPath,
      [cli, "replay", "--source", portable],
      { env, timeout: 30000 },
    );
    expect(offline.stdout).toBe(replay.stdout);
    const restored = await exec(
      process.execPath,
      [
        cli,
        "import",
        "--source",
        portable,
        "--server",
        server.url,
        "--state-dir",
        root,
      ],
      { env, timeout: 30000 },
    );
    const restoredId = JSON.parse(restored.stdout).streamId;
    expect(restoredId).not.toBe(first.streamId);
    const restoredReplay = await exec(
      process.execPath,
      [
        cli,
        "replay",
        "--stream",
        restoredId,
        "--server",
        server.url,
        "--state-dir",
        root,
      ],
      { env, timeout: 30000 },
    );
    expect(restoredReplay.stdout).toBe(replay.stdout);
    const timed = await exec(
      process.execPath,
      [...replayArgs, "--speed", "1024"],
      {
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(timed.stdout).toBe(replay.stdout);
    const compressed = await exec(
      process.execPath,
      [...replayArgs, "--idle-cap-ms", "0"],
      { env, timeout: 30000 },
    );
    expect(compressed.stdout).toBe(replay.stdout);
    const uncompressed = await exec(
      process.execPath,
      [...replayArgs, "--idle-cap-ms", "off", "--speed", "1024"],
      { env, timeout: 30000 },
    );
    expect(uncompressed.stdout).toBe(replay.stdout);
    await expect(
      exec(process.execPath, [...replayArgs, "--idle-cap-ms", "-1"], { env }),
    ).rejects.toThrow();

    const snapshotHeaders = {
      authorization: `Bearer ${JSON.parse(credential).secret}`,
      "content-type": "application/json",
    };
    const metadata = await (
      await fetch(`${server.url}/api/v1/streams/${first.streamId}`, {
        headers: snapshotHeaders,
      })
    ).json();
    const publication = await fetch(
      `${server.url}/api/v1/streams/${first.streamId}/snapshots`,
      {
        method: "POST",
        headers: snapshotHeaders,
        body: JSON.stringify({
          revision: metadata.revision,
          throughServerSeq: metadata.serverSeq,
        }),
      },
    );
    expect(publication.status).toBe(201);
    expect((await publication.json()).snapshot.format).toBe(
      "agentlive.paged-state",
    );
    const seek = await exec(
      process.execPath,
      [...replayArgs, "--from-ms", "1000000"],
      { env, timeout: 30000 },
    );
    expect(seek.stdout).toContain("Playback state");
    expect(seek.stdout).toContain("CLI test message");
    expect(seek.stdout.match(/CLI test message/g)).toHaveLength(1);
    expect(seek.stdout).toContain("Recording ended");
    const leaseLedger = JSON.parse(
      await readFile(
        join(
          root,
          "server",
          "sessions",
          first.streamId,
          "snapshots",
          "leases.json",
        ),
        "utf8",
      ),
    );
    expect(leaseLedger.revision).toBe(metadata.revision);
    expect(leaseLedger.leases).toEqual([]); // Replay released its temporary import lease.

    await expect(
      exec(process.execPath, [...replayArgs, "--from-ms", "-1"], { env }),
    ).rejects.toThrow();
    await expect(
      exec(process.execPath, [...replayArgs, "--speed", "0"], { env }),
    ).rejects.toThrow();
    await expect(
      exec(process.execPath, [...replayArgs, "--interactive"], { env }),
    ).rejects.toThrow();
    await expect(
      exec(process.execPath, [...replayArgs, "--anonymous"], {
        env,
        timeout: 30000,
      }),
    ).rejects.toMatchObject({ code: 1 });
    const timestamp = "2026-09-01T00:00:00.000Z";
    const additional = [
      {
        agent: "codex",
        body:
          JSON.stringify({
            type: "session_meta",
            timestamp,
            payload: { id: "cli_codex", timestamp, cli_version: "0.153.4" },
          }) + "\n",
        extra: [],
      },
      {
        agent: "kimi",
        body:
          JSON.stringify({
            type: "metadata",
            protocol_version: "1.5",
            created_at: Date.parse(timestamp),
          }) + "\n",
        extra: ["--native-session", "cli_kimi", "--native-agent", "main"],
      },
      {
        agent: "opencode",
        body: JSON.stringify({
          info: { id: "ses_cli", time: { created: Date.parse(timestamp) } },
          messages: [],
        }),
        extra: [],
      },
    ];
    for (const fixture of additional) {
      const path = join(root, fixture.agent + ".json");
      await writeFile(path, fixture.body);
      const imported = JSON.parse(
        (
          await exec(
            process.execPath,
            [
              cli,
              "import",
              "--agent",
              fixture.agent,
              "--source",
              path,
              "--state-dir",
              root,
              "--server",
              server.url,
              ...fixture.extra,
            ],
            { env, timeout: 30000 },
          )
        ).stdout,
      );
      expect(imported.agent).toBe(fixture.agent);
      expect(imported.event).toBe("imported");
    }
    const secret = JSON.parse(credential).secret;
    expect(first).not.toHaveProperty("writeSecret");
    const serverPort = new URL(server.url).port;
    server.child.kill("SIGTERM");
    expect(await server.exited).toBe(143);
    server = undefined;
    server = await start(root, serverPort);
    expect(await readFile(server.ownerFile, "utf8")).toBe(credential);
    const response = await fetch(
      `${server.url}/api/v1/streams/${first.streamId}`,
      { headers: { authorization: `Bearer ${secret}` } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).lifecycle).toBe("ended");
    const publisher = spawn(
      process.execPath,
      [
        cli,
        "publish",
        "--agent",
        "claude",
        "--native-session",
        "cli_session",
        "--source-root",
        root,
        "--state-dir",
        root,
        "--server",
        server.url,
        "--resume-import",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let publisherOutput = "";
    let publisherError = "";
    publisher.stdout.on("data", (chunk) => {
      publisherOutput += chunk.toString();
    });
    publisher.stderr.on("data", (chunk) => {
      publisherError += chunk.toString();
    });
    const publisherExit = new Promise((resolve, reject) => {
      publisher.once("exit", resolve);
      publisher.once("error", reject);
    });
    try {
      await expect
        .poll(
          () => {
            if (publisherError) throw new Error(publisherError);
            return publisherOutput;
          },
          { timeout: 30000 },
        )
        .toContain('"event":"source-caught-up"');
      expect(publisherOutput).toContain(first.streamId);
      const reopened = await fetch(
        `${server.url}/api/v1/streams/${first.streamId}`,
        { headers: { authorization: `Bearer ${secret}` } },
      );
      expect((await reopened.json()).lifecycle).toBe("open");
    } finally {
      publisher.kill("SIGTERM");
      await publisherExit;
    }
  } finally {
    if (server) {
      server.child.kill("SIGTERM");
      await server.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
it.each([false, true])(
  "managed launch (fresh=%s) captures native output and preserves an open recording",
  async (fresh) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-cli-launch-"));
    let server: Awaited<ReturnType<typeof start>> | undefined;
    try {
      server = await start(root);
      const source = join(root, "source.jsonl");
      const row = (uuid: string, content: string) => ({
        type: "user",
        sessionId: "managed_session",
        uuid,
        timestamp: "2026-09-01T00:00:00Z",
        message: { content },
      });
      if (!fresh)
        await writeFile(
          source,
          JSON.stringify(row("initial", "initial message")) + "\n",
        );
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "claude"),
        fresh
          ? `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv[2] !== '--session-id') process.exit(3);\nconst id = process.argv[3];\nconst saved = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "launches"))} + '/' + id + '.json'));\nif (saved.nativeSessionId !== id) process.exit(4);\nfs.writeFileSync(${JSON.stringify(source)}, JSON.stringify({...${JSON.stringify(row("final", "MANAGED_FINAL_MESSAGE"))}, sessionId: id}) + '\\n');\nconsole.log('NATIVE_TERMINAL_OUTPUT');\n`
          : `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--resume','managed_session'])) process.exit(3);\nfs.appendFileSync(${JSON.stringify(source)}, ${JSON.stringify(JSON.stringify(row("final", "MANAGED_FINAL_MESSAGE")) + "\n")});\nconsole.log('NATIVE_TERMINAL_OUTPUT');\n`,
        { mode: 0o700 },
      );
      await appendFile(
        join(bin, "claude"),
        `
const childDir = require('node:path').join(${JSON.stringify(root)}, process.argv[3], 'subagents');
fs.mkdirSync(childDir, {recursive:true});
fs.writeFileSync(require('node:path').join(childDir, 'agent-worker.jsonl'), JSON.stringify({...${JSON.stringify(row("final", "CLAUDE_CHILD_FINAL"))}, sessionId:process.argv[3], agentId:'worker', isSidechain:true}) + '\\n');
`,
      );
      const launched = await exec(
        process.execPath,
        [
          cli,
          "publish",
          "--agent",
          "claude",
          "--include-children",
          ...(fresh ? [] : ["--native-session", "managed_session"]),
          "--source-root",
          root,
          "--launch",
          "--cwd",
          root,
          "--server",
          server.url,
          "--state-dir",
          root,
        ],
        { env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 30000 },
      );
      expect(launched.stdout).toBe("NATIVE_TERMINAL_OUTPUT\n");
      const publishing = launched.stderr
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((row) => row.event === "publishing");
      expect(publishing.streamId).toBeTruthy();
      const owner = JSON.parse(await readFile(server.ownerFile, "utf8"));
      const response = await fetch(
        `${server.url}/api/v1/streams/${publishing.streamId}`,
        { headers: { authorization: `Bearer ${owner.secret}` } },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).lifecycle).toBe("open");
      const journal = await PublisherJournal.open(join(root, "publisher"), {
        serverOrigin: server.url,
        agent: "claude",
        nativeSessionId: fresh
          ? JSON.parse(launched.stderr.split("\n")[0]!).nativeSessionId
          : "managed_session",
      });
      try {
        expect(journal.identity.streamId).toBe(publishing.streamId);
        const events = [];
        for await (const event of journal.pending(0)) events.push(event);
        expect(JSON.stringify(events)).toContain("MANAGED_FINAL_MESSAGE");
        expect(JSON.stringify(events)).toContain("CLAUDE_CHILD_FINAL");
        expect(
          events.filter((event) => event.content.kind === "session.started"),
        ).toHaveLength(1);
      } finally {
        await journal.close();
      }
    } finally {
      server?.child.kill("SIGTERM");
      await server?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("shows help and rejects options that do not apply before starting a server", async () => {
  expect(
    (await exec(process.execPath, [cli, "--help"], { env })).stdout,
  ).toContain("agentlive import");
  await expect(
    exec(process.execPath, [cli, "serve", "--source", "unused"], { env }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(
    exec(
      process.execPath,
      [cli, "import", "--agent", "unknown", "--source", "unused"],
      { env },
    ),
  ).rejects.toMatchObject({ code: 1 });
});

it("fresh launch retains its identity when native exits without a transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-empty-launch-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "claude"),
      "#!/usr/bin/env node\nprocess.exit(0);\n",
      { mode: 0o700 },
    );
    let diagnostic = "";
    await exec(
      process.execPath,
      [
        cli,
        "publish",
        "--agent",
        "claude",
        "--launch",
        "--source-root",
        root,
        "--state-dir",
        root,
        "--server",
        server.url,
      ],
      { env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 30000 },
    ).then(
      () => {
        throw new Error("Expected launch failure");
      },
      (error) => {
        expect(error.code).toBe(1);
        diagnostic = error.stderr;
      },
    );
    expect(diagnostic).toContain("without a complete identified transcript");
    const identity = JSON.parse(diagnostic.split("\n")[0]!).nativeSessionId;
    expect(
      JSON.parse(
        await readFile(join(root, "launches", `${identity}.json`), "utf8"),
      ).nativeSessionId,
    ).toBe(identity);
  } finally {
    server?.child.kill("SIGTERM");
    await server?.exited;
    await rm(root, { recursive: true, force: true });
  }
});

it("managed OpenCode launches and resumes with final snapshot capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-launch-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "opencode"),
      `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
const path = require('node:path').join(process.cwd(), 'native-state.json');
const auth = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
if(process.argv[2] === 'serve') {
  const server = http.createServer((req,res) => {
    if(req.headers.authorization !== auth) {res.writeHead(401);res.end();return;}
    const childInfo = {id:'ses_child',parentID:'ses_managed',time:{created:1}};
    const info = req.url.startsWith('/session/ses_child') ? childInfo : {id:'ses_managed',time:{created:1}};
    if(req.url.endsWith('/children')) {res.end(JSON.stringify(req.url === '/session/ses_managed/children' ? [childInfo] : []));return;}
    if(req.url === '/event') {res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\\n\\n');return;}
    if(req.url === '/global/health') {res.end(JSON.stringify({healthy:true}));return;}
    if(req.url === '/update') {fs.writeFileSync(path,JSON.stringify({text:'OPENCODE_MANAGED_FINAL'}));res.end('{}');return;}
    if(req.url.endsWith('/message')) {
      const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : {text:'initial'};
      res.end(JSON.stringify([{info:{id:'msg1',sessionID:info.id,role:'assistant',time:{created:1,completed:2}},parts:[{id:'part1',sessionID:info.id,messageID:'msg1',type:'text',text:state.text}]}]));return;
    }
    res.end(JSON.stringify(info));
  });
  server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
} else if(process.argv[2] === 'attach') {
  if(process.argv[4] !== '--session' || process.argv[5] !== 'ses_managed') process.exit(3);
  fetch(process.argv[3]+'/update',{headers:{authorization:auth}}).then(async res=>{await res.text();console.log('OPENCODE_NATIVE_OUTPUT');});
} else process.exit(4);
`,
      { mode: 0o700 },
    );
    let streamId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await exec(
        process.execPath,
        [
          cli,
          "publish",
          "--agent",
          "opencode",
          "--launch",
          "--include-children",
          "--cwd",
          root,
          "--state-dir",
          root,
          "--server",
          server.url,
          ...(attempt ? ["--native-session", "ses_managed"] : []),
        ],
        { env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 30000 },
      );
      expect(result.stdout).toBe("OPENCODE_NATIVE_OUTPUT\n");
      const recording = result.stderr
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.event === "publishing");
      if (streamId) expect(recording.streamId).toBe(streamId);
      streamId = recording.streamId;
      const journal = await PublisherJournal.open(join(root, "publisher"), {
        agent: "opencode",
        serverOrigin: server.url,
        nativeSessionId: "ses_managed",
      });
      try {
        const events = [];
        for await (const event of journal.pending(0)) events.push(event);
        expect(JSON.stringify(events)).toContain("OPENCODE_MANAGED_FINAL");
      } finally {
        await journal.close();
      }
    }
    expect(
      (await stat(join(root, "managed-opencode-credential.json"))).mode & 0o777,
    ).toBe(0o600);
  } finally {
    server?.child.kill("SIGTERM");
    await server?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it.each([
  { partial: false, fresh: false },
  { partial: true, fresh: false },
  { partial: false, fresh: true },
  { partial: true, fresh: true },
])(
  "managed Kimi family drains child logs after exit (%j)",
  async ({ partial, fresh }) => {
    const root = await mkdtemp(
      join(tmpdir(), "agentlive-kimi-managed-family-"),
    );
    let server: Awaited<ReturnType<typeof start>> | undefined;
    try {
      server = await start(root);
      const agents = join(root, "session_managed_kimi", "agents");
      const metadata =
        JSON.stringify({
          type: "metadata",
          protocol_version: "1.5",
          created_at: 1,
        }) + "\n";
      const row = (text: string) =>
        JSON.stringify({
          type: "context.append_message",
          time: 2,
          message: { role: "user", content: [{ type: "text", text }] },
        }) + "\n";
      for (const agent of fresh ? [] : ["main", "worker"]) {
        await mkdir(join(agents, agent), { recursive: true });
        await writeFile(
          join(agents, agent, "wire.jsonl"),
          metadata + row(agent),
        );
      }
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "kimi"),
        `#!/usr/bin/env node
const fs = require('node:fs');
if(process.argv[2] === 'acp') {
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const {id,method}=JSON.parse(line);if(id===undefined)return;
  let result={protocolVersion:1};
  if(method==='session/new') {
   for(const agent of ['main','worker']) {
    const dir=require('node:path').join(${JSON.stringify(agents)},agent);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(require('node:path').join(dir,'wire.jsonl'),${JSON.stringify(metadata)});
   }
   result={sessionId:'session_managed_kimi'};
  } else if(method !== 'initialize')process.exit(4);
  console.log(JSON.stringify({id,result}));
 });
} else {
if(JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--session',${JSON.stringify(fresh ? "session_managed_kimi" : "managed_kimi")}])) process.exit(3);
fs.appendFileSync(${JSON.stringify(join(agents, "worker", "wire.jsonl"))}, ${JSON.stringify(row("FINAL_CHILD_MESSAGE") + (partial ? '{"type":' : ""))});
fs.mkdirSync(${JSON.stringify(join(agents, "late"))});
fs.writeFileSync(${JSON.stringify(join(agents, "late", "wire.jsonl"))}, ${JSON.stringify(metadata + row("LATE_CHILD_MESSAGE"))});
console.log('KIMI_NATIVE_EXIT');
}
`,
        { mode: 0o700 },
      );
      let diagnostic = "";
      const result = await exec(
        process.execPath,
        [
          cli,
          "publish",
          "--agent",
          "kimi",
          ...(fresh
            ? []
            : ["--native-session", "managed_kimi", "--native-agent", "main"]),
          "--source-root",
          root,
          "--include-children",
          "--launch",
          "--cwd",
          root,
          "--state-dir",
          root,
          "--server",
          server.url,
        ],
        { env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 30000 },
      ).then(
        (result) => {
          expect(partial).toBe(false);
          diagnostic = result.stderr;
          return result;
        },
        (error) => {
          expect(partial).toBe(true);
          expect(error.code).toBe(1);
          diagnostic = error.stderr;
          expect(diagnostic).toContain("incomplete final record");
          return { stdout: error.stdout };
        },
      );
      expect(result.stdout).toBe("KIMI_NATIVE_EXIT\n");
      if (!partial) {
        const journal = await PublisherJournal.open(join(root, "publisher"), {
          serverOrigin: server.url,
          agent: "kimi",
          nativeSessionId: "managed_kimi",
        });
        try {
          const events = [];
          for await (const event of journal.pending(0)) events.push(event);
          expect(JSON.stringify(events)).toContain("FINAL_CHILD_MESSAGE");
          expect(JSON.stringify(events)).toContain("LATE_CHILD_MESSAGE");
          expect(
            events.filter((event) => event.content.kind === "session.started"),
          ).toHaveLength(1);
        } finally {
          await journal.close();
        }
      }
    } finally {
      server?.child.kill("SIGTERM");
      await server?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "managed Codex family selects the root and drains final descendant output (fresh=%s)",
  async (fresh) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-codex-cli-family-"));
    let server: Awaited<ReturnType<typeof start>> | undefined;
    try {
      server = await start(root);
      const sources = join(root, "sources"),
        bin = join(root, "bin");
      await mkdir(sources);
      await mkdir(bin);
      const timestamp = "2026-09-01T00:00:00Z";
      const metadata = (id: string, parent?: string) =>
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: {
            id,
            session_id: "root",
            parent_thread_id: parent,
            timestamp,
            cli_version: "test",
          },
        }) + "\n";
      const message = (text: string) =>
        JSON.stringify({
          type: "event_msg",
          timestamp,
          payload: {
            type: "item_completed",
            item: {
              id: "shared",
              type: "AgentMessage",
              content: [{ type: "Text", text }],
            },
          },
        }) + "\n";
      if (!fresh)
        await writeFile(
          join(sources, "root.jsonl"),
          metadata("root") + message("ROOT_MESSAGE"),
        );
      await writeFile(join(sources, "child.jsonl"), metadata("child", "root"));
      await writeFile(
        join(bin, "codex"),
        `#!/usr/bin/env node
const fs=require('node:fs');
if (process.argv[2] === 'app-server') {
 require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); if(request.id === undefined)return;
  let result={};
  if(request.method === 'thread/start') {
   if(request.params.historyMode !== 'legacy' || request.params.ephemeral !== false)process.exit(4);
   result={thread:{id:'root',path:${JSON.stringify(join(sources, "root.jsonl"))}}};
  } else if(request.method === 'thread/name/set') {
   if(request.params.threadId !== 'root')process.exit(5);
   fs.writeFileSync(${JSON.stringify(join(sources, "root.jsonl"))},${JSON.stringify(metadata("root") + message("ROOT_MESSAGE"))});
  } else if(request.method !== 'initialize') process.exit(6);
  console.log(JSON.stringify({id:request.id,result}));
 });
} else {
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['resume','root']))process.exit(3);
fs.appendFileSync(${JSON.stringify(join(sources, "child.jsonl"))},${JSON.stringify(message("FINAL_CODEX_CHILD"))});
console.log('CODEX_NATIVE_EXIT');
}
`,
        { mode: 0o700 },
      );
      const result = await exec(
        process.execPath,
        [
          cli,
          "publish",
          "--agent",
          "codex",
          ...(fresh ? [] : ["--native-session", "root"]),
          "--source-root",
          sources,
          "--include-children",
          "--launch",
          "--cwd",
          root,
          "--server",
          server.url,
          "--state-dir",
          root,
        ],
        { env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 30000 },
      );
      expect(result.stdout).toBe("CODEX_NATIVE_EXIT\n");
      const journal = await PublisherJournal.open(join(root, "publisher"), {
        serverOrigin: server.url,
        agent: "codex",
        nativeSessionId: "root",
      });
      try {
        const events = [];
        for await (const event of journal.pending(0))
          events.push(event.content);
        expect(
          events.filter((event) => event.kind === "session.started"),
        ).toHaveLength(1);
        expect(
          events
            .filter((event) => event.kind === "message.reconciled")
            .map((event) => event.payload.text)
            .sort(),
        ).toEqual(["FINAL_CODEX_CHILD", "ROOT_MESSAGE"]);
      } finally {
        await journal.close();
      }
    } finally {
      server?.child.kill("SIGTERM");
      await server?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["kimi", "claude", "codex", "opencode"])(
  "imports %s family through the CLI and preserves it in offline archive replay",
  async (native) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-cli-family-import-"));
    let server: Awaited<ReturnType<typeof start>> | undefined;
    try {
      server = await start(root);
      if (native === "opencode") {
        const directory = join(root, "exports");
        await mkdir(directory);
        for (const agent of ["main", "worker"]) {
          const id = agent === "main" ? "cli_family" : "worker";
          await writeFile(
            join(directory, `${agent}.json`),
            JSON.stringify({
              info: {
                id,
                ...(agent === "worker" ? { parentID: "cli_family" } : {}),
                time: { created: 1 },
              },
              messages: [
                {
                  info: {
                    id: "same-message",
                    sessionID: id,
                    role: "assistant",
                    time: { created: 1, completed: 2 },
                  },
                  parts: [
                    {
                      id: "same-part",
                      sessionID: id,
                      messageID: "same-message",
                      type: "text",
                      text: `CLI_FAMILY_${agent}`,
                    },
                  ],
                },
              ],
            }),
          );
        }
      } else if (native === "codex") {
        await mkdir(join(root, "sources"));
        const timestamp = "2026-09-01T00:00:00Z";
        for (const agent of ["main", "worker"])
          await writeFile(
            join(root, "sources", `${agent}.jsonl`),
            JSON.stringify({
              type: "session_meta",
              timestamp,
              payload: {
                id: agent === "main" ? "cli_family" : agent,
                session_id: "cli_family",
                ...(agent === "worker"
                  ? { parent_thread_id: "cli_family" }
                  : {}),
                timestamp,
                cli_version: "test",
              },
            }) +
              "\n" +
              JSON.stringify({
                type: "event_msg",
                timestamp,
                payload: {
                  type: "item_completed",
                  item: {
                    id: "same",
                    type: "AgentMessage",
                    content: [{ type: "Text", text: `CLI_FAMILY_${agent}` }],
                  },
                },
              }) +
              "\n",
          );
      } else if (native === "claude") {
        const directory = join(root, "cli_family", "subagents");
        await mkdir(directory, { recursive: true });
        for (const agent of ["main", "worker"])
          await writeFile(
            agent === "main"
              ? join(root, "main.jsonl")
              : join(directory, "agent-worker.jsonl"),
            JSON.stringify({
              type: "user",
              sessionId: "cli_family",
              uuid: "same",
              timestamp: "2026-09-01T00:00:00Z",
              ...(agent === "worker"
                ? { agentId: agent, isSidechain: true }
                : {}),
              message: { content: `CLI_FAMILY_${agent}` },
            }) + "\n",
          );
      } else
        for (const agent of ["main", "worker"]) {
          const directory = join(root, "session_cli_family", "agents", agent);
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, "wire.jsonl"),
            JSON.stringify({
              type: "metadata",
              protocol_version: "1.5",
              created_at: 1,
            }) +
              "\n" +
              JSON.stringify({
                type: "context.append_message",
                time: 2,
                message: {
                  role: "user",
                  content: [{ type: "text", text: `CLI_FAMILY_${agent}` }],
                },
              }) +
              "\n",
          );
        }
      const common = ["--state-dir", root, "--server", server.url];
      const imported = JSON.parse(
        (
          await exec(
            process.execPath,
            [
              cli,
              "import",
              "--agent",
              native,
              ...(native === "opencode"
                ? ["--source", join(root, "exports", "main.json")]
                : ["--native-session", "cli_family"]),
              ...(native === "kimi" ? ["--native-agent", "main"] : []),
              "--source-root",
              native === "opencode"
                ? join(root, "exports")
                : native === "codex"
                  ? join(root, "sources")
                  : root,
              "--include-children",
              ...common,
            ],
            { env, timeout: 30000 },
          )
        ).stdout,
      );
      const replay = await exec(
        process.execPath,
        [cli, "replay", "--stream", imported.streamId, ...common],
        { env, timeout: 30000 },
      );
      expect(replay.stdout).toContain("CLI_FAMILY_main");
      expect(replay.stdout).toContain("CLI_FAMILY_worker");
      expect(replay.stdout).toContain("Recording ended");
      const path = join(root, "family.agentlive");
      await exec(
        process.execPath,
        [
          cli,
          "export",
          "--stream",
          imported.streamId,
          "--output",
          path,
          ...common,
        ],
        { env, timeout: 30000 },
      );
      const offline = await exec(
        process.execPath,
        [cli, "replay", "--source", path],
        { env, timeout: 30000 },
      );
      expect(offline.stdout).toBe(replay.stdout);
      if (native === "opencode") {
        const { createServer } = await import("node:http");
        const snapshots = await Promise.all(
          ["main", "worker"].map(async (agent) =>
            JSON.parse(
              await readFile(join(root, "exports", `${agent}.json`), "utf8"),
            ),
          ),
        );
        const nativeServer = createServer((req, res) => {
          const id = req.url?.split("/")[2];
          const snapshot = snapshots.find((value) => value.info.id === id);
          if (req.url === "/event") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(": connected\n\n");
            return;
          }
          if (!snapshot) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              req.url?.endsWith("/children")
                ? snapshots
                    .filter((value) => value.info.parentID === id)
                    .map((value) => value.info)
                : req.url?.endsWith("/message")
                  ? snapshot.messages
                  : snapshot.info,
            ),
          );
        });
        await new Promise<void>((resolve) =>
          nativeServer.listen(0, "127.0.0.1", resolve),
        );
        const nativeOrigin = `http://127.0.0.1:${(nativeServer.address() as { port: number }).port}`;
        const publisher = spawn(
          process.execPath,
          [
            cli,
            "publish",
            "--agent",
            "opencode",
            "--native-session",
            "cli_family",
            "--native-server",
            nativeOrigin,
            "--source",
            join(root, "exports", "main.json"),
            "--include-children",
            "--resume-import",
            ...common,
          ],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "",
          error = "";
        publisher.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        publisher.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        const exit = new Promise((resolve, reject) => {
          publisher.once("close", resolve);
          publisher.once("error", reject);
        });
        try {
          await expect
            .poll(
              () => {
                if (error) throw new Error(error);
                return output;
              },
              { timeout: 30000 },
            )
            .toContain(imported.streamId);
        } finally {
          publisher.kill("SIGTERM");
          await exit;
          nativeServer.closeAllConnections();
          await new Promise<void>((resolve) =>
            nativeServer.close(() => resolve()),
          );
        }
      }
      if (native === "kimi" || native === "claude" || native === "codex") {
        const publisher = spawn(
          process.execPath,
          [
            cli,
            "publish",
            "--agent",
            native,
            "--native-session",
            "cli_family",
            ...(native === "kimi" ? ["--native-agent", "main"] : []),
            "--source-root",
            native === "codex" ? join(root, "sources") : root,
            "--include-children",
            "--resume-import",
            ...common,
          ],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "",
          error = "";
        publisher.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        publisher.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        const exit = new Promise((resolve, reject) => {
          publisher.once("close", resolve);
          publisher.once("error", reject);
        });
        try {
          await expect
            .poll(
              () => {
                if (error) throw new Error(error);
                return output;
              },
              { timeout: 30000 },
            )
            .toContain('"event":"source-caught-up"');
          expect(output).toContain(imported.streamId);
        } finally {
          publisher.kill("SIGTERM");
          await exit;
        }
      }
    } finally {
      server?.child.kill("SIGTERM");
      await server?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);
