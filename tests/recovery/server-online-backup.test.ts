import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PublishedEvent } from "@agentlive/protocol";
import { startServer } from "../../packages/server/src/http.js";
import { restoreServer } from "../../packages/server/src/restore.js";
import { RecordingStore } from "../../packages/server/src/store.js";
import type {
  RecordingSession,
  Lease,
} from "../../packages/server/src/session.js";
import { requestOnlineBackup } from "../../packages/client/src/backup.js";

const run = promisify(execFile);
const owner = "a".repeat(64);
const writeSecret = "b".repeat(64);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function event(
  streamId: string,
  producerSeq: number,
  content: PublishedEvent["content"],
): PublishedEvent {
  return {
    protocolVersion: 1,
    streamId,
    producerEpoch: "e",
    producerSeq,
    observedAt: new Date().toISOString(),
    clockSegmentId: "clock",
    elapsedMs: producerSeq,
    fidelity: "delta",
    source: { agent: "synthetic", sessionId: "online-backup" },
    content,
  };
}

/** One publisher appending messages and attachments in producer order. */
class Writer {
  seq = 0;
  constructor(
    private readonly session: RecordingSession,
    private readonly lease: Lease,
  ) {}
  async step() {
    const id = this.session.info.id;
    const next = this.seq + 1;
    if (next === 1)
      await this.session.append(this.lease, [
        event(id, next, {
          kind: "message.started",
          payload: { messageId: "m1", role: "assistant" },
        }),
      ]);
    else if (next % 4 === 0) {
      const bytes = Buffer.from(`attachment bytes ${next}`);
      const attachment = {
        artifactId: `file-${next}`,
        version: 1,
        filename: `file-${next}.txt`,
        mediaType: "text/plain",
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      };
      await this.session.uploadAttachment(
        writeSecret,
        attachment,
        (async function* () {
          yield bytes;
        })(),
      );
      await this.session.append(this.lease, [
        event(id, next, {
          kind: "attachment.available",
          payload: { attachment },
        }),
      ]);
    } else
      await this.session.append(this.lease, [
        event(id, next, {
          kind: "message.text.append",
          payload: { messageId: "m1", text: `text ${next} ` },
        }),
      ]);
    this.seq = next;
  }
}

async function postBackup(url: string, body: unknown, credential = owner) {
  return fetch(`${url}/api/v1/admin/backup`, {
    method: "POST",
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function ndjson(response: Response) {
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await sleep(5);
  }
}

it("backs up a running server while writes continue, restores a consistent prefix, and always releases the barrier", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentlive-online-backup-")),
  );
  const state = join(root, "state"),
    directory = join(state, "server");
  await mkdir(state);
  const signal = AbortSignal.timeout(60_000);
  let server = await startServer({
    directory,
    ownerSecret: owner,
    port: 0,
    snapshots: { batchEvents: 5, pollMs: 5, intervalMs: 20 },
  });
  try {
    const store = server.store;
    const session = await store.create({
      ownerId: "local",
      requestId: "online",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret,
      visibility: "private",
      title: "Online backup fixture",
    });
    const id = session.info.id;
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 1,
      revision: session.info.revision,
    });
    const writer = new Writer(session, lease);
    for (let index = 0; index < 20; index++) await writer.step();

    // Concurrent publisher and ledger writes during a successful online backup.
    let writing = true;
    let grantsIssued = 0;
    const writerTask = (async () => {
      while (writing) {
        await writer.step();
        if (writer.seq % 7 === 0) {
          const grant = await fetch(
            `${server.url}/api/v1/streams/${id}/viewing-grants`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${owner}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                label: `grant ${writer.seq}`,
                expiresAt: Date.now() + 3_600_000,
              }),
            },
          );
          expect(grant.status).toBe(201);
          grantsIssued++;
        }
      }
    })();
    await until(() => writer.seq >= 40);
    const before = writer.seq;
    const output = join(root, "backup");
    const phases: string[] = [];
    const result = await requestOnlineBackup({
      serverOrigin: server.url,
      credential: owner,
      output,
      signal,
      onProgress: (progress) => {
        if (progress.phase) phases.push(progress.phase);
      },
    });
    await until(() => writer.seq >= before + 20);
    writing = false;
    await writerTask;
    expect(grantsIssued).toBeGreaterThan(0);
    expect(phases).toEqual(["attachments", "barrier", "verifying"]);
    expect(result).toMatchObject({ mode: "online", output, recordings: 1 });
    expect(result.barrierMs).toBeLessThan(30_000);

    const manifest = JSON.parse(
      await readFile(join(output, "backup.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      format: "agentlive.server-backup",
      version: 1,
      recordings: 1,
    });
    for (const file of manifest.files) {
      const bytes = await readFile(join(output, file.path));
      expect(bytes.length).toBe(file.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.hash);
      expect((await stat(join(output, file.path))).mode & 0o077).toBe(0);
      expect(file.path).not.toMatch(/\/snapshots\/|\.uploads/);
    }
    expect(
      JSON.parse(await readFile(join(output, "owner.json"), "utf8")),
    ).toEqual({ version: 1, secret: owner });

    const restoredPath = join(root, "restored");
    const restored = await restoreServer({
      source: output,
      output: restoredPath,
      signal,
    });
    expect(restored.recordings).toBe(1);
    const live = await readFile(
      join(directory, "sessions", id, "events.jsonl"),
    );
    const copied = await readFile(
      join(restoredPath, "server", "sessions", id, "events.jsonl"),
    );
    // The restored log is an exact byte prefix of the live log.
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.length).toBeLessThan(live.length);
    expect(live.subarray(0, copied.length).equals(copied)).toBe(true);
    const restoredStore = await RecordingStore.open(
      join(restoredPath, "server"),
    );
    try {
      // Opening validates the hash chain and every referenced attachment.
      const recovered = await restoredStore.get(id);
      try {
        const events = await Array.fromAsync(
          recovered.history(0, recovered.boundary.sequence),
        );
        const published = events.filter(
          (item) => item.origin.type === "publisher",
        );
        expect(published.length).toBeGreaterThanOrEqual(before);
        expect(published.length).toBeLessThan(writer.seq);
        published.forEach((item, index) => {
          expect(
            item.origin.type === "publisher" && item.origin.event.producerSeq,
          ).toBe(index + 1);
        });
        const attachments = join(
          restoredPath,
          "server",
          "sessions",
          id,
          "attachments",
        );
        for (const item of events)
          if (item.content.kind === "attachment.available")
            expect(
              (
                await stat(
                  join(attachments, item.content.payload.attachment.hash),
                )
              ).isFile(),
            ).toBe(true);
      } finally {
        restoredStore.release(recovered);
      }
    } finally {
      await restoredStore.close();
    }
    const restoredGrants = JSON.parse(
      await readFile(
        join(restoredPath, "server", "viewing-grants.json"),
        "utf8",
      ),
    );
    expect(restoredGrants.grants.length).toBeGreaterThan(0);

    // Authorization: only the operator owner credential may run a backup.
    const grant = (await (
      await fetch(`${server.url}/api/v1/streams/${id}/viewing-grants`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          label: "viewer",
          expiresAt: Date.now() + 60_000,
        }),
      })
    ).json()) as { token: string };
    for (const credential of [
      "", // anonymous
      "c".repeat(64),
      writeSecret,
      grant.token,
    ]) {
      const denied = await postBackup(
        server.url,
        { output: join(root, "denied") },
        credential,
      );
      expect(denied.status).toBe(401);
      expect((await denied.json()).error.code).toBe("unauthorized");
    }
    const cookie = await fetch(`${server.url}/api/v1/admin/backup`, {
      method: "POST",
      headers: {
        cookie: "__Host-agentlive-session=forged",
        "content-type": "application/json",
      },
      body: JSON.stringify({ output: join(root, "denied") }),
    });
    expect(cookie.status).toBe(401);
    expect(await readdir(root)).not.toContain("denied");

    // Destination validation happens before any work starts.
    for (const invalid of [
      { output: "relative-backup" },
      { output: join(directory, "nested") },
      { output: state },
      { output: output },
      { output: join(root, "missing", "backup") },
      { output: join(root, "extra"), unknown: true },
      { output: join(root, "slow"), barrierTimeoutMs: 10 },
    ]) {
      const rejected = await postBackup(server.url, invalid);
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.code).toBe("invalid_request");
    }
    expect(await readdir(root)).not.toContain("extra");
    expect(await readdir(directory)).not.toContain("nested");

    // A pending barrier stops admission: mutations wait, a second backup is busy.
    let unblock!: () => void;
    const blocked = store.barrier.shared(
      () => new Promise<void>((resolve) => (unblock = resolve)),
    );
    const second = join(root, "second");
    const pending = await postBackup(server.url, { output: second });
    expect(pending.status).toBe(200);
    const pendingLines = ndjson(pending);
    await until(() => store.barrier.paused);
    const busy = await postBackup(server.url, { output: join(root, "busy") });
    expect(busy.status).toBe(503);
    expect((await busy.json()).error.code).toBe("retry_later");
    expect(await readdir(root)).not.toContain("busy");
    let admitted = false;
    const waiting = writer.step().then(() => {
      admitted = true;
    });
    await sleep(100);
    expect(admitted).toBe(false);
    // Reads continue while the barrier is pending.
    const read = await fetch(`${server.url}/api/v1/streams/${id}`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(read.status).toBe(200);
    unblock();
    await blocked;
    const completed = await pendingLines;
    expect(completed.at(-1)).toMatchObject({ event: "backup", recordings: 1 });
    await waiting;
    expect(admitted).toBe(true);

    // Barrier deadline: the backup fails, its output is deleted, writes resume.
    const blockedAgain = store.barrier.shared(
      () => new Promise<void>((resolve) => (unblock = resolve)),
    );
    const timedOut = await postBackup(server.url, {
      output: join(root, "timed-out"),
      barrierTimeoutMs: 1000,
    });
    expect(timedOut.status).toBe(200);
    const failure = (await ndjson(timedOut)).at(-1);
    expect(failure).toMatchObject({ event: "error", code: "retry_later" });
    expect(failure.message).toContain("barrier");
    expect(await readdir(root)).not.toContain("timed-out");
    expect(store.barrier.paused).toBe(false);
    const afterFailure = writer.seq;
    await writer.step();
    expect(writer.seq).toBe(afterFailure + 1);
    unblock();
    await blockedAgain;

    // The CLI runs an online backup through the server with the owner credential.
    const env = { ...process.env, AGENTLIVE_OWNER_SECRET: owner };
    const cli = await run(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "backup",
        "--server",
        server.url,
        "--output",
        join(root, "cli-online"),
      ],
      { env },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({
      event: "backup",
      mode: "online",
      recordings: 1,
    });
    expect(cli.stdout).not.toContain(owner);
    expect((await stat(join(root, "cli-online", "backup.json"))).isFile()).toBe(
      true,
    );
    // Offline backup against a live directory points at online backup.
    const offlineEnv = { ...process.env };
    delete offlineEnv.AGENTLIVE_OWNER_SECRET;
    const offline = run(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "backup",
        "--state-dir",
        state,
        "--output",
        join(root, "cli-offline"),
      ],
      { env: offlineEnv },
    );
    await expect(offline).rejects.toMatchObject({
      stderr: expect.stringContaining("--server"),
    });

    // Shutdown cancels a backup waiting on the barrier and removes its output.
    const blockedAtClose = store.barrier.shared(
      () => new Promise<void>((resolve) => (unblock = resolve)),
    );
    const closing = await postBackup(server.url, {
      output: join(root, "closing"),
    });
    expect(closing.status).toBe(200);
    const closingLines = ndjson(closing).catch(() => []);
    await until(() => store.barrier.paused);
    await server.close();
    await closingLines;
    expect(await readdir(root)).not.toContain("closing");
    unblock();
    await blockedAtClose;
    server = await startServer({ directory, ownerSecret: owner, port: 0 });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it("write barrier drains admitted mutations, admits nested work, and reopens after cancellation", async () => {
  const { WriteBarrier } =
    await import("../../packages/server/src/write-barrier.js");
  const barrier = new WriteBarrier();
  const order: string[] = [];
  let finishOuter!: () => void;
  const outerGate = new Promise<void>((resolve) => (finishOuter = resolve));
  const outer = barrier.shared(async () => {
    order.push("outer");
    await outerGate;
    // Nested work inside an admitted mutation must not wait for the pending barrier.
    await barrier.shared(async () => {
      order.push("nested");
    });
    // Detached work is admitted on its own, after the exclusive holder.
    void barrier.detached(async () => {
      order.push("detached");
    });
  });
  const exclusive = barrier.exclusive(async () => {
    order.push("exclusive");
  }, AbortSignal.timeout(5000));
  expect(barrier.paused).toBe(true);
  const late = barrier.shared(async () => {
    order.push("late");
  });
  await expect(
    barrier.exclusive(async () => {}, AbortSignal.timeout(5000)),
  ).rejects.toMatchObject({ code: "retry_later" });
  finishOuter();
  await Promise.all([outer, exclusive, late]);
  await sleep(0);
  expect(order.slice(0, 3)).toEqual(["outer", "nested", "exclusive"]);
  expect(order.slice(3).sort()).toEqual(["detached", "late"]);
  expect(barrier.paused).toBe(false);

  // Cancellation while draining reopens admission for waiting mutations.
  let release!: () => void;
  const held = barrier.shared(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const stop = new AbortController();
  const cancelled = barrier.exclusive(async () => {
    order.push("never");
  }, stop.signal);
  const waiting = barrier.shared(async () => "admitted");
  stop.abort(new Error("cancel backup"));
  await expect(cancelled).rejects.toThrow("cancel backup");
  expect(await waiting).toBe("admitted");
  release();
  await held;
  expect(order).not.toContain("never");
});
