import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile),
  cli = resolve("packages/cli/dist/main.js");
const env = { PATH: process.env.PATH ?? "" };

async function start(stateDir: string, host?: string) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "serve",
      "--state-dir",
      stateDir,
      "--port",
      "0",
      ...(host ? ["--host", host] : []),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const lines = createInterface({ input: child.stdout! });
  const ready = await new Promise<{
    url: string;
    ownerFile: string;
    viewerUrls: string[];
    reachability: string;
    note: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup")), 10000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  lines.close();
  return { child, exited, ...ready };
}

const row = (uuid: string, content: string) =>
  JSON.stringify({
    type: "user",
    sessionId: "publication_session",
    uuid,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: { content },
  }) + "\n";

/** Run publish until its captured prefix is acknowledged, optionally inspecting while attached. */
async function publishUntilLive(
  args: string[],
  whileAttached?: () => Promise<void>,
) {
  const child = spawn(process.execPath, [cli, "publish", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const events: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout! });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("publish did not become live: " + stderr)),
        15000,
      );
      let caughtUp = false;
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "source-caught-up") caughtUp = true;
        if (caughtUp && event.status === "live") {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("publish exited: " + stderr));
      });
    });
    await whileAttached?.();
  } finally {
    child.kill("SIGINT");
    await exited;
    lines.close();
  }
  return events;
}

const run = async (args: string[]) =>
  JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout);

it("reports, pauses, resumes, finishes and reopens a live publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publication-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    const owner = JSON.parse(await readFile(server.ownerFile, "utf8"));
    const source = join(root, "source.jsonl");
    await writeFile(source, row("first", "FIRST_MESSAGE"));
    const publishArgs = [
      "--agent",
      "claude",
      "--source",
      source,
      "--server",
      server.url,
      "--state-dir",
      root,
    ];
    const state = ["--state-dir", root];
    const first = await publishUntilLive(publishArgs, async () => {
      const attached = await run(["status", ...state]);
      expect(attached.bindings).toHaveLength(1);
      expect(attached.bindings[0]).toMatchObject({
        attached: true,
        capturedEvents: null,
        sharing: "enabled",
      });
      await expect(
        exec(
          process.execPath,
          [cli, "pause", "--stream", attached.bindings[0].streamId, ...state],
          { env },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("publisher process is attached"),
      });
    });
    const publishing = first.find((event) => event.event === "publishing")!;
    const streamId = publishing.streamId as string;
    expect(publishing.viewerUrl).toBe(
      `${server.url}/?stream=${encodeURIComponent(streamId)}`,
    );
    const short = await fetch(`${server.url}/s/${streamId}`, {
      redirect: "manual",
    });
    expect(short.status).toBe(302);
    expect(short.headers.get("location")).toBe(
      `/?stream=${encodeURIComponent(streamId)}`,
    );
    expect(
      (await fetch(`${server.url}/s/..%2Fx`, { redirect: "manual" })).status,
    ).toBe(404);
    const status = await run(["status", "--stream", streamId, ...state]);
    expect(status.bindings).toHaveLength(1);
    const binding = status.bindings[0];
    expect(binding).toMatchObject({
      agent: "claude",
      nativeSessionId: "publication_session",
      streamId,
      mode: "live",
      sharing: "enabled",
      attached: false,
      lifecycle: "open",
      pendingEvents: 0,
      oldestPendingObservedAt: null,
      viewerUrl: publishing.viewerUrl,
    });
    expect(binding.capturedEvents).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(owner.secret);
    expect(JSON.stringify(status)).not.toContain("FIRST_MESSAGE");
    expect(
      (await run(["status", "--stream", "unrelated", ...state])).bindings,
    ).toEqual([]);

    // Paused bindings refuse to capture or deliver until explicitly resumed.
    expect(await run(["pause", "--stream", streamId, ...state])).toMatchObject({
      sharing: "paused",
      changed: true,
    });
    expect(await run(["pause", "--stream", streamId, ...state])).toMatchObject({
      sharing: "paused",
      changed: false,
    });
    await appendFile(source, row("second", "SECOND_MESSAGE"));
    await expect(
      exec(process.execPath, [cli, "publish", ...publishArgs], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Publishing is paused"),
    });
    expect((await run(["status", ...state])).bindings[0].capturedEvents).toBe(
      binding.capturedEvents,
    );
    expect(
      await run(["resume", "--source", binding.bindingDirectory, ...state]),
    ).toMatchObject({ sharing: "enabled", changed: true });
    await publishUntilLive(publishArgs);
    const resumed = (await run(["status", ...state])).bindings[0];
    expect(resumed.capturedEvents).toBeGreaterThan(binding.capturedEvents);
    expect(resumed.pendingEvents).toBe(0);

    // Finish is idempotent and blocks further publication.
    const finished = await run(["finish", "--stream", streamId, ...state]);
    expect(finished).toMatchObject({ streamId, completed: true });
    expect(await run(["finish", "--stream", streamId, ...state])).toEqual(
      finished,
    );
    const metadata = async () =>
      (
        await fetch(`${server!.url}/api/v1/streams/${streamId}`, {
          headers: { authorization: `Bearer ${owner.secret}` },
        })
      ).json();
    expect((await metadata()).lifecycle).toBe("ended");
    expect((await run(["status", ...state])).bindings[0].lifecycle).toBe(
      "finished",
    );
    await expect(
      exec(process.execPath, [cli, "publish", ...publishArgs], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("finish operation"),
    });

    // Reopen restores the same recording and binding for continued capture.
    const reopened = await run(["reopen", "--stream", streamId, ...state]);
    expect(reopened).toMatchObject({
      streamId,
      viewerUrl: publishing.viewerUrl,
    });
    expect((await metadata()).lifecycle).toBe("open");
    await expect(
      exec(process.execPath, [cli, "reopen", "--stream", streamId, ...state], {
        env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no completed finish"),
    });
    await appendFile(source, row("third", "THIRD_MESSAGE"));
    await publishUntilLive(publishArgs);
    const after = (await run(["status", ...state])).bindings[0];
    expect(after).toMatchObject({ lifecycle: "open", pendingEvents: 0 });
    expect(after.capturedEvents).toBeGreaterThan(resumed.capturedEvents);

    // A viewer URL selects both server and recording for terminal replay.
    const replay = await exec(
      process.execPath,
      [cli, "replay", publishing.viewerUrl as string, ...state],
      { env },
    );
    expect(replay.stdout).toContain("FIRST_MESSAGE");
    expect(replay.stdout).toContain("SECOND_MESSAGE");
    expect(replay.stdout).toContain("THIRD_MESSAGE");

    const report = await run(["doctor", "--server", server.url, ...state]);
    expect(
      report.checks.find((check: { name: string }) => check.name === "server"),
    ).toMatchObject({ status: "ok" });
    expect(
      report.checks.find(
        (check: { name: string }) => check.name === "publishers",
      ),
    ).toMatchObject({ status: "ok" });
    expect(JSON.stringify(report)).not.toContain(owner.secret);
  } finally {
    server?.child.kill("SIGTERM");
    await server?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

it("rejects ambiguous selection and malformed viewer URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publication-args-"));
  try {
    for (const args of [
      ["pause", "--state-dir", root],
      ["pause", "--stream", "a", "--source", root, "--state-dir", root],
      ["resume", "--stream", "missing", "--state-dir", root],
      ["replay", "not a url", "--state-dir", root],
      ["watch", "https://user:pw@example.test/?stream=x", "--state-dir", root],
      ["watch", "https://example.test/nothing", "--state-dir", root],
    ])
      await expect(
        exec(process.execPath, [cli, ...args], { env }),
      ).rejects.toMatchObject({ code: 1 });
    expect(await run(["status", "--state-dir", root])).toEqual({
      bindings: [],
    });
    const report = await run([
      "doctor",
      "--server",
      "http://127.0.0.1:9",
      "--state-dir",
      root,
    ]);
    expect(
      report.checks.find((check: { name: string }) => check.name === "server")
        .status,
    ).toBe("warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("replays the committed sample recording and exits quietly when output closes", async () => {
  const sample = resolve("docs/sample/agentlive-sample.agentlive");
  const full = await exec(
    process.execPath,
    [cli, "replay", "--source", sample],
    {
      env,
    },
  );
  expect(full.stdout).toContain("Sample: fixing accent handling in slugify");
  expect(full.stdout).toContain("Attachment: image.png");
  expect(full.stdout).toContain("Tests: 6 passed, 6 total");
  expect(full.stdout.trimEnd().endsWith("Recording ended")).toBe(true);
  const child = spawn(process.execPath, [cli, "replay", "--source", sample], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  child.stdout!.once("data", () => child.stdout!.destroy());
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

it("retires a finished binding so the same native session starts a new recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publication-retire-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    const source = join(root, "source.jsonl");
    await writeFile(source, row("first", "FIRST_RECORDING"));
    const publishArgs = [
      "--agent",
      "claude",
      "--source",
      source,
      "--server",
      server.url,
      "--state-dir",
      root,
    ];
    const state = ["--state-dir", root];
    const first = (await publishUntilLive(publishArgs)).find(
      (event) => event.event === "publishing",
    )!.streamId as string;
    await expect(
      exec(process.execPath, [cli, "retire", "--stream", first, ...state], {
        env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("run finish first"),
    });
    await run(["finish", "--stream", first, ...state]);
    const retired = await run(["retire", "--stream", first, ...state]);
    expect(retired).toMatchObject({ streamId: first, agent: "claude" });
    expect(retired.retiredDirectory).toContain(
      join(root, "publisher", "retired"),
    );
    expect((await run(["status", ...state])).bindings).toEqual([]);
    await appendFile(source, row("second", "SECOND_RECORDING"));
    const second = (await publishUntilLive(publishArgs)).find(
      (event) => event.event === "publishing",
    )!.streamId as string;
    expect(second).not.toBe(first);
    const status = (await run(["status", ...state])).bindings;
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ streamId: second, lifecycle: "open" });
  } finally {
    server?.child.kill("SIGTERM");
    await server?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("reports honest viewer reachability for loopback and wildcard binds", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-publication-reach-"));
  const servers: Awaited<ReturnType<typeof start>>[] = [];
  try {
    const local = await start(join(root, "local"));
    servers.push(local);
    expect(local.reachability).toBe("this-machine");
    expect(local.viewerUrls).toEqual([local.url + "/"]);
    expect(local.note).toContain("only from this machine");
    const wide = await start(join(root, "wide"), "0.0.0.0");
    servers.push(wide);
    expect(wide.reachability).toBe("network");
    const port = new URL(wide.url).port;
    expect(wide.viewerUrls[0]).toBe(`http://127.0.0.1:${port}/`);
    expect(wide.viewerUrls.every((url) => !url.includes("0.0.0.0"))).toBe(true);
    expect((await fetch(wide.viewerUrls[0] + "healthz")).status).toBe(200);
  } finally {
    for (const server of servers) {
      server.child.kill("SIGTERM");
      await server.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

it("reads and changes recording visibility from the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-visibility-cli-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root);
    const state = ["--state-dir", root, "--server", server.url];
    const source = join(root, "source.jsonl");
    await writeFile(source, row("first", "VISIBILITY_MESSAGE"));
    const imported = await run([
      "import",
      "--agent",
      "claude",
      "--source",
      source,
      ...state,
    ]);
    const stream = imported.streamId as string;
    const anonymous = () =>
      fetch(`${server!.url}/api/v1/streams/${stream}`).then(
        (response) => response.status,
      );

    const initial = await run(["visibility", "--stream", stream, ...state]);
    expect(initial).toMatchObject({ streamId: stream, visibility: "private" });
    expect(await anonymous()).toBe(403);

    const shared = await run([
      "visibility",
      "--stream",
      stream,
      "--visibility",
      "public",
      ...state,
    ]);
    expect(shared).toMatchObject({ visibility: "public", changed: true });
    expect(shared.version).toBe(initial.version + 1);
    expect(await anonymous()).toBe(200);

    // Repeating the request is a no-op rather than a second version.
    const repeated = await run([
      "visibility",
      "--stream",
      stream,
      "--visibility",
      "public",
      ...state,
    ]);
    expect(repeated).toMatchObject({
      visibility: "public",
      changed: false,
      version: shared.version,
    });

    const restricted = await run([
      "visibility",
      "--stream",
      stream,
      "--visibility",
      "private",
      ...state,
    ]);
    expect(restricted).toMatchObject({ visibility: "private", changed: true });
    expect(await anonymous()).toBe(403);

    await expect(
      exec(
        process.execPath,
        [
          cli,
          "visibility",
          "--stream",
          stream,
          "--visibility",
          "open",
          ...state,
        ],
        { env },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("must be private, unlisted or public"),
    });
    await expect(
      exec(process.execPath, [cli, "visibility", ...state], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires --stream"),
    });
  } finally {
    server?.child.kill("SIGTERM");
    await server?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
