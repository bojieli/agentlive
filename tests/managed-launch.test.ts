import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  managedFileResume,
  nativeResumeCommand,
} from "../packages/cli/src/managed-launch.js";

it("constructs explicit native resume argument arrays", () => {
  expect(nativeResumeCommand("codex", "session_id")).toEqual({
    command: "codex",
    args: ["resume", "session_id"],
  });
  expect(nativeResumeCommand("claude", "session_id").args).toEqual([
    "--resume",
    "session_id",
  ]);
  expect(nativeResumeCommand("kimi", "session_id").args).toEqual([
    "--session",
    "session_id",
  ]);
  expect(() => nativeResumeCommand("codex", "bad/id")).toThrow();
  expect(() => nativeResumeCommand("codex", "--last")).toThrow("option prefix");
});

it("starts after catch-up and captures the final native bytes before detaching", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-launch-"));
  const source = join(root, "source.jsonl");
  await writeFile(source, "initial\n");
  const statuses: string[] = [];
  let caughtUp = false,
    lastOffset = 0;
  try {
    const code = await managedFileResume({
      agent: "claude",
      nativeSessionId: "session_id",
      sourcePath: source,
      cwd: root,
      signal: new AbortController().signal,
      spawnNative: ((command, args, options) => {
        expect(caughtUp).toBe(true);
        expect(command).toBe("claude");
        expect(args).toEqual(["--resume", "session_id"]);
        expect(options).toMatchObject({
          cwd: root,
          shell: false,
          stdio: "inherit",
        });
        return spawn(
          process.execPath,
          [
            "-e",
            "require('node:fs').appendFileSync(process.argv[1], 'final\\n')",
            source,
          ],
          { stdio: "ignore" },
        );
      }) as typeof spawn,
      publish: async (hooks) => {
        caughtUp = true;
        await hooks.onCaughtUp!({ producerEvents: 0 });
        while (!hooks.signal.aborted) {
          lastOffset = (await stat(source)).size;
          hooks.onProgress!({
            sourceCursor: { offset: lastOffset, prefixHash: "0".repeat(64) },
            producerEvents: 1,
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
      onStatus: (status) => statuses.push(status),
    });
    expect(code).toBe(0);
    expect(lastOffset).toBe(Buffer.byteLength(await readFile(source)));
    expect(statuses).toContain("native-exited; draining retained source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the native process available after capture failure and reports recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-launch-failure-"));
  const marker = join(root, "native-completed");
  const statuses: string[] = [];
  try {
    await expect(
      managedFileResume({
        agent: "kimi",
        nativeSessionId: "session_id",
        sourcePath: marker,
        cwd: root,
        signal: new AbortController().signal,
        spawnNative: (() =>
          spawn(
            process.execPath,
            [
              "-e",
              "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'completed'), 100)",
              marker,
            ],
            { stdio: "ignore" },
          )) as typeof spawn,
        publish: async (hooks) => {
          await hooks.onCaughtUp!({ producerEvents: 0 });
          throw new Error("capture unavailable");
        },
        onStatus: (status) => statuses.push(status),
      }),
    ).rejects.toThrow("capture unavailable");
    expect(await readFile(marker, "utf8")).toBe("completed");
    expect(statuses.some((status) => status.includes("capture-failed"))).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not launch when capture fails before catch-up", async () => {
  let spawned = false;
  await expect(
    managedFileResume({
      agent: "codex",
      nativeSessionId: "session_id",
      sourcePath: "/unused",
      cwd: process.cwd(),
      signal: new AbortController().signal,
      spawnNative: (() => {
        spawned = true;
        throw new Error("unexpected launch");
      }) as typeof spawn,
      publish: async () => {
        throw new Error("source invalid");
      },
      onStatus: () => {},
    }),
  ).rejects.toThrow("source invalid");
  expect(spawned).toBe(false);
});

it("cancellation stops and reaps the owned child", async () => {
  const abort = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  await managedFileResume({
    agent: "codex",
    nativeSessionId: "session_id",
    sourcePath: "/unused",
    cwd: process.cwd(),
    signal: abort.signal,
    spawnNative: (() => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      setTimeout(() => abort.abort(), 30);
      return child;
    }) as typeof spawn,
    publish: async (hooks) => {
      await hooks.onCaughtUp!({ producerEvents: 0 });
      await new Promise<void>((resolve) =>
        hooks.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    onStatus: () => {},
  });
  expect(child?.signalCode).toBe("SIGTERM");
});

it("reports an undrained suffix instead of silently claiming complete capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-launch-drain-"));
  const source = join(root, "source");
  await writeFile(source, "incomplete suffix");
  try {
    await expect(
      managedFileResume({
        agent: "claude",
        nativeSessionId: "session_id",
        sourcePath: source,
        cwd: root,
        signal: new AbortController().signal,
        drainTimeoutMs: 20,
        spawnNative: (() =>
          spawn(process.execPath, ["-e", ""], {
            stdio: "ignore",
          })) as typeof spawn,
        publish: async (hooks) => {
          await hooks.onCaughtUp!({ producerEvents: 0 });
          await new Promise<void>((resolve) =>
            hooks.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        },
        onStatus: () => {},
      }),
    ).rejects.toThrow("drain timed out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
