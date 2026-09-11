import { expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/dist/index.js";
import { RecordingSnapshotClient } from "../../packages/client/dist/index.js";
import { BrowserPagedSession } from "../../apps/web/src/paged-session.js";
import type {
  EventContent,
  SnapshotLease,
} from "../../packages/protocol/src/index.js";

it.each(["released", "expired"])(
  "rebuilds an exact frozen memory view after its server lease is %s during lazy text reads",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-memory-lease-"));
    const secret = "a".repeat(64);
    const server = await startServer({
      directory,
      ownerSecret: secret,
      port: 0,
    });
    const stop = new AbortController();
    let viewer: BrowserPagedSession | undefined;
    const imported: SnapshotLease[] = [];
    const failures: string[] = [];
    const readBlob = RecordingSnapshotClient.prototype.readBlob;
    const reads = vi
      .spyOn(RecordingSnapshotClient.prototype, "readBlob")
      .mockImplementation(async function (...args) {
        try {
          return await readBlob.apply(this, args);
        } catch (error) {
          failures.push((error as { code: string }).code);
          throw error;
        }
      });
    const acquire = RecordingSnapshotClient.prototype.acquireLease;
    const spy = vi
      .spyOn(RecordingSnapshotClient.prototype, "acquireLease")
      .mockImplementation(async function (...args) {
        const result = await acquire.apply(this, args);
        if (result) imported.push(result);
        return result;
      });
    try {
      const stream = await server.store.create({
        ownerId: "local",
        requestId: "memory-lease",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: secret,
        title: "Memory lease recovery",
        visibility: "private",
      });
      const { lease } = await stream.resume(secret, {
        publisherId: "pub",
        producerEpoch: "epoch",
        attempt: 1,
        revision: stream.info.revision,
      });
      let sequence = 0;
      const append = (content: EventContent) =>
        stream.append(lease, [
          {
            protocolVersion: 1,
            streamId: stream.info.id,
            producerEpoch: "epoch",
            producerSeq: ++sequence,
            observedAt: new Date().toISOString(),
            clockSegmentId: "clock",
            elapsedMs: sequence * 1000,
            fidelity: "delta",
            source: { agent: "synthetic", sessionId: "memory-lease" },
            content,
          },
        ]);
      const original =
        "first page".padEnd(16384, ".") +
        "second page".padEnd(16384, ".") +
        "last page";
      await append({
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      });
      await append({
        kind: "message.text.append",
        payload: { messageId: "m", text: original },
      });
      await stream.buildSnapshot(stream.info.serverSeq);
      viewer = await BrowserPagedSession.open(
        stream.info.id,
        secret,
        stop.signal,
        () => {},
        server.url,
        { cache: false },
      );
      expect(viewer.snapshotEvents).toBe(stream.info.serverSeq);
      viewer.setPlaying(false);
      const frozen = viewer.view;
      const row = (await frozen.rows(0, 1, stop.signal))[0]!;
      const text = (await frozen.load(row, stop.signal))!.texts.text!;
      expect(await text.read(0, 10, stop.signal)).toBe("first page");
      expect(imported.length).toBeGreaterThan(0);
      if (mode === "released") {
        for (const retained of imported)
          await stream.releaseSnapshotLease(retained.token, stop.signal);
      } else {
        const file = join(
          directory,
          "sessions",
          stream.info.id,
          "snapshots",
          "leases.json",
        );
        const ledger = JSON.parse(await readFile(file, "utf8"));
        for (const retained of ledger.leases) retained.expiresAt = 1;
        await writeFile(file, JSON.stringify(ledger), { mode: 0o600 });
      }
      const boundary = frozen.sequence;
      // A real HTTP content request now sees stale_lease for the invalidated token.
      expect(await text.read(32768, 9, stop.signal)).toBe("last page");
      expect(failures).toContain("stale_lease");
      expect(viewer.view.sequence).toBe(boundary);
      expect(viewer.follow).toBe(false);
      expect(viewer.error).toBe("");
      await append({
        kind: "message.text.append",
        payload: { messageId: "m", text: " new receipt" },
      });
      await expect.poll(() => viewer!.received).toBe(boundary + 1);
      expect(viewer.view.sequence).toBe(boundary);
      expect(await text.read(32768, 9, stop.signal)).toBe("last page");
      await viewer.seek(viewer.duration, true);
      const latestRow = (await viewer.view.rows(0, 1, stop.signal))[0]!;
      const latest = (await viewer.view.load(latestRow, stop.signal))!.texts
        .text!;
      expect(await latest.read(32768, latest.units - 32768, stop.signal)).toBe(
        "last page new receipt",
      );
    } finally {
      spy.mockRestore();
      reads.mockRestore();
      await viewer?.close();
      stop.abort();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
