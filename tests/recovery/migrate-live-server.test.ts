import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import {
  abandonLiveMigration,
  migrateLiveBinding,
} from "../../packages/cli/src/migrate-live.js";

const exec = promisify(execFile),
  cli = resolve("packages/cli/dist/main.js");
const sourceCredential = "a".repeat(64);
const targetCredential = "b".repeat(64);
const SECRET = "cross-server-live-secret-8801";

type Server = Awaited<ReturnType<typeof startServer>>;

async function history(server: Server, streamId: string) {
  const session = await server.store.get(streamId);
  try {
    const events = [];
    for await (const event of session.history(0, session.boundary.sequence))
      events.push(event);
    return { info: session.info, events };
  } finally {
    server.store.release(session);
  }
}

/** Run the publisher until it has captured and delivered everything in the source. */
async function publishUntilCaughtUp(
  args: string[],
  env: Record<string, string>,
  until?: (events: Record<string, unknown>[]) => Promise<void>,
) {
  const child = spawn(process.execPath, [cli, "publish", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  const events: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout! });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("publish never became live: " + stderr)),
        20000,
      );
      let caughtUp = false,
        live = false;
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "source-caught-up") caughtUp = true;
        if (event.event === "publisher-status") live = event.status === "live";
        if (caughtUp && live) {
          clearTimeout(timer);
          done();
        }
      });
      child.once("exit", () =>
        reject(new Error("publish exited early: " + stderr)),
      );
    });
    await until?.(events);
    // Give the acknowledgement of the last captured event time to arrive.
    await new Promise((done) => setTimeout(done, 300));
  } finally {
    child.kill("SIGINT");
    await exited;
    lines.close();
  }
  return events;
}

const claudeRow = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    sessionId: "crossmig",
    uuid: id,
    timestamp: "2026-09-01T00:00:01Z",
    message: { content: text },
  }) + "\n";

it("replaces a live binding on another server and continues it there", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-live-cross-server-"));
  const sourceServer = await startServer({
    directory: join(root, "source-server"),
    ownerSecret: sourceCredential,
    port: 0,
  });
  const targetServer = await startServer({
    directory: join(root, "target-server"),
    ownerSecret: targetCredential,
    port: 0,
  });
  try {
    const source = join(root, "crossmig.jsonl");
    await writeFile(source, claudeRow("first", `first ${SECRET} visible`));
    const state = ["--state-dir", root];
    const sourceEnv = {
      PATH: process.env.PATH ?? "",
      AGENTLIVE_OWNER_SECRET: sourceCredential,
    };
    const publishArgs = [
      "--agent",
      "claude",
      "--source",
      source,
      "--server",
      sourceServer.url,
      ...state,
    ];
    await publishUntilCaughtUp(publishArgs, sourceEnv);
    // The CLI learns the extra redaction value the same way an operator supplies it.
    const migrateEnv = {
      PATH: process.env.PATH ?? "",
      AGENTLIVE_OWNER_SECRET: sourceCredential,
      CROSS_MIGRATION_TOKEN: SECRET,
    };
    const run = async (args: string[], env = migrateEnv) =>
      JSON.parse(
        (await exec(process.execPath, [cli, ...args], { env, timeout: 40000 }))
          .stdout,
      );
    const binding = (await run(["status", ...state])).bindings[0];
    const sourceStreamId = binding.streamId as string;
    const inspection = await run([
      "inspect-migration",
      "--source",
      binding.bindingDirectory,
    ]);
    await appendFile(source, claudeRow("second", `second ${SECRET} visible`));

    const options = {
      directory: binding.bindingDirectory as string,
      nativeSource: source,
      operationId: "cross-server-live",
      expectedManifestHash: inspection.published.manifestHash as string,
      disposition: "retain" as const,
      ownerCredential: sourceCredential,
      secrets: [SECRET, sourceCredential, targetCredential],
      signal: AbortSignal.timeout(60000),
    };
    // A destination needs its own credential, and the source's is not one.
    await expect(
      migrateLiveBinding({
        ...options,
        targetServerOrigin: targetServer.url,
      }),
    ).rejects.toThrow("separate destination credential");
    await expect(
      migrateLiveBinding({
        ...options,
        targetServerOrigin: targetServer.url,
        targetOwnerCredential: sourceCredential,
      }),
    ).rejects.toThrow();
    expect(
      (await readdir(join(root, "live-migrations")).catch(() => [])).length,
    ).toBe(0);

    // Interrupt right after the intent is durable: the destination key is fenced
    // even though nothing has been placed there yet.
    await expect(
      migrateLiveBinding({
        ...options,
        targetServerOrigin: targetServer.url,
        targetOwnerCredential: targetCredential,
        onPhase: (phase) => {
          if (phase === "intent") throw new Error("died after intent");
        },
      }),
    ).rejects.toThrow("died after intent");
    await expect(
      exec(
        process.execPath,
        [
          cli,
          "publish",
          "--agent",
          "claude",
          "--source",
          source,
          "--server",
          targetServer.url,
          ...state,
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            AGENTLIVE_OWNER_SECRET: targetCredential,
          },
          timeout: 20000,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("live-binding migration is pending"),
    });

    const targetOwnerFile = join(root, "destination-owner.json");
    await writeFile(
      targetOwnerFile,
      JSON.stringify({ version: 1, secret: targetCredential }),
      { mode: 0o600 },
    );
    const args = [
      "migrate-live",
      "--stream",
      sourceStreamId,
      "--native-source",
      source,
      "--operation-id",
      options.operationId,
      "--expected-manifest-hash",
      options.expectedManifestHash,
      "--old-recording",
      "retain",
      "--target-server",
      targetServer.url,
      "--target-owner-file",
      targetOwnerFile,
      "--redact-env",
      "CROSS_MIGRATION_TOKEN",
      ...state,
    ];
    const receipt = await run(args);
    expect(receipt).toMatchObject({
      event: "live-migrated",
      serverOrigin: sourceServer.url,
      targetServerOrigin: targetServer.url,
      sourceStreamId,
      completed: true,
      visibility: "private",
    });
    // The replacement occupies the destination's own binding key.
    expect(receipt.bindingDirectory).not.toBe(binding.bindingDirectory);
    expect(await run(args)).toEqual(receipt);

    const targetId = receipt.target.streamId as string;
    const replaced = await history(targetServer, targetId);
    const text = JSON.stringify(replaced.events);
    expect(text).toContain("second ");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(sourceCredential);
    expect(text).not.toContain(targetCredential);
    expect(replaced.info.visibility).toBe("private");
    expect(replaced.info.migrationOrigin!.externalSource).toEqual({
      serverOrigin: sourceServer.url,
      verification: "owner-declared",
    });
    // The old recording is ended in place on its own server, with its own content.
    const original = await history(sourceServer, sourceStreamId);
    expect(original.info.lifecycle).toBe("ended");
    expect(JSON.stringify(original.events)).toContain(SECRET);

    // The placed binding continues the replacement on the destination server.
    await appendFile(source, claudeRow("third", "third across servers"));
    await publishUntilCaughtUp(
      [
        "--agent",
        "claude",
        "--source",
        source,
        "--server",
        targetServer.url,
        ...state,
        "--resume-import",
        "--title",
        receipt.continuation.title,
      ],
      {
        PATH: process.env.PATH ?? "",
        AGENTLIVE_OWNER_SECRET: targetCredential,
        // The source credential kept filtering what it filtered before the move.
        AGENTLIVE_SOURCE_SECRET: sourceCredential,
        CROSS_MIGRATION_TOKEN: SECRET,
      },
      () =>
        expect
          .poll(
            async () =>
              JSON.stringify((await history(targetServer, targetId)).events),
            { timeout: 15000 },
          )
          .toContain("third across servers"),
    );
    expect((await run(["status", ...state])).bindings).toMatchObject([
      { streamId: targetId, serverOrigin: targetServer.url },
    ]);
  } finally {
    await sourceServer.close();
    await targetServer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);

it("abandons a server migration with the destination credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-live-cross-abandon-"));
  const sourceServer = await startServer({
    directory: join(root, "source-server"),
    ownerSecret: sourceCredential,
    port: 0,
  });
  const targetServer = await startServer({
    directory: join(root, "target-server"),
    ownerSecret: targetCredential,
    port: 0,
  });
  try {
    const source = join(root, "crossmig.jsonl");
    await writeFile(source, claudeRow("first", "first visible"));
    const state = ["--state-dir", root];
    const sourceEnv = {
      PATH: process.env.PATH ?? "",
      AGENTLIVE_OWNER_SECRET: sourceCredential,
    };
    const publishArgs = [
      "--agent",
      "claude",
      "--source",
      source,
      "--server",
      sourceServer.url,
      ...state,
    ];
    await publishUntilCaughtUp(publishArgs, sourceEnv);
    const run = async (args: string[], env = sourceEnv) =>
      JSON.parse(
        (await exec(process.execPath, [cli, ...args], { env, timeout: 40000 }))
          .stdout,
      );
    const binding = (await run(["status", ...state])).bindings[0];
    const sourceStreamId = binding.streamId as string;
    const inspection = await run([
      "inspect-migration",
      "--source",
      binding.bindingDirectory,
    ]);
    const common = {
      directory: binding.bindingDirectory as string,
      nativeSource: source,
      operationId: "cross-server-abandon",
      expectedManifestHash: inspection.published.manifestHash as string,
      disposition: "retain" as const,
      ownerCredential: sourceCredential,
      targetServerOrigin: targetServer.url,
      targetOwnerCredential: targetCredential,
      signal: AbortSignal.timeout(60000),
    };
    // Stop once the replacement exists on the destination but nothing was ended.
    await expect(
      migrateLiveBinding({
        ...common,
        secrets: [sourceCredential, targetCredential],
        onPhase: (phase) => {
          if (phase === "imported") throw new Error("died after import");
        },
      }),
    ).rejects.toThrow("died after import");
    const staged = (await run(["list", "--server", targetServer.url], {
      PATH: process.env.PATH ?? "",
      AGENTLIVE_OWNER_SECRET: targetCredential,
    })) as { recordings: { id: string }[] };
    expect(staged.recordings).toHaveLength(1);

    const abandon = { ...common, confirmRemoval: true };
    // The source still reads back, so the operation could still finish.
    await expect(abandonLiveMigration(abandon)).rejects.toThrow(
      "can still complete",
    );
    await rm(source);
    // Removing the staged replacement is the destination's authorization, not the
    // source server's.
    await expect(
      abandonLiveMigration({ ...abandon, targetOwnerCredential: undefined }),
    ).rejects.toThrow("destination credential");
    await expect(
      abandonLiveMigration({
        ...abandon,
        targetOwnerCredential: sourceCredential,
      }),
    ).rejects.toThrow();
    const receipt = await abandonLiveMigration(abandon);
    expect(receipt).toMatchObject({
      serverOrigin: sourceServer.url,
      targetServerOrigin: targetServer.url,
      sourceStreamId,
      stagedRecording: {
        streamId: staged.recordings[0]!.id,
        disposition: "removed",
      },
      abandoned: true,
    });
    expect(
      (
        (await run(["list", "--server", targetServer.url], {
          PATH: process.env.PATH ?? "",
          AGENTLIVE_OWNER_SECRET: targetCredential,
        })) as { recordings: unknown[] }
      ).recordings,
    ).toHaveLength(0);
    // Both keys are released: the source publishes on, and the destination is free.
    await writeFile(source, claudeRow("first", "first visible"));
    await appendFile(source, claudeRow("second", "second visible"));
    await publishUntilCaughtUp(publishArgs, sourceEnv);
    expect(
      JSON.stringify((await history(sourceServer, sourceStreamId)).events),
    ).toContain("second visible");
    const other = await publishUntilCaughtUp(
      [
        "--agent",
        "claude",
        "--source",
        source,
        "--server",
        targetServer.url,
        "--state-dir",
        root,
      ],
      {
        PATH: process.env.PATH ?? "",
        AGENTLIVE_OWNER_SECRET: targetCredential,
      },
    );
    expect(other.find((event) => event.event === "publishing")).toBeDefined();
  } finally {
    await sourceServer.close();
    await targetServer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
