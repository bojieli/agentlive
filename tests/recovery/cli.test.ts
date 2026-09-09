import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
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
    const args = [
      cli,
      "import",
      "--agent",
      "claude",
      "--source",
      source,
      "--state-dir",
      root,
      "--server",
      server.url,
    ];
    const first = JSON.parse(
      (await exec(process.execPath, args, { env, timeout: 10000 })).stdout,
    );
    expect(first.event).toBe("imported");
    expect(first.visibility).toBe("private");
    const second = JSON.parse(
      (await exec(process.execPath, args, { env, timeout: 10000 })).stdout,
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
      timeout: 10000,
    });
    expect(replay.stdout).toContain("CLI test message");
    expect(replay.stdout).toContain("Recording ended");
    const timed = await exec(
      process.execPath,
      [...replayArgs, "--speed", "1024"],
      {
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(timed.stdout).toBe(replay.stdout);
    await expect(
      exec(process.execPath, [...replayArgs, "--speed", "0"], { env }),
    ).rejects.toThrow();
    await expect(
      exec(process.execPath, [...replayArgs, "--interactive"], { env }),
    ).rejects.toThrow();
    await expect(
      exec(process.execPath, [...replayArgs, "--anonymous"], {
        env,
        timeout: 10000,
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
            { env, timeout: 10000 },
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
        "--source",
        source,
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
          { timeout: 10000 },
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
