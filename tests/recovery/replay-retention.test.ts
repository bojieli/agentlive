import { it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecordingSnapshotClient } from "../../packages/client/dist/index.js";
import { replayRecording } from "../../packages/cli/src/replay.js";
import { startServer } from "../../packages/server/dist/index.js";
import {
  PagedReducer,
  PagedTerminalRenderer,
} from "../../packages/playback/dist/index.js";
import { ProtocolError } from "../../packages/protocol/dist/index.js";
it("reconstructs replay after partial rendering expires and does not retry a failed replacement", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentlive-replay-retention-"),
  );
  const secret = "a".repeat(64);
  const server = await startServer({ directory, ownerSecret: secret, port: 0 });
  let output = "";
  try {
    const stream = await server.store.create({
      ownerId: "local",
      requestId: "replay",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: secret,
      title: "Replay",
      visibility: "private",
    });
    const { lease } = await stream.resume(secret, {
      publisherId: "pub",
      producerEpoch: "epoch",
      attempt: 1,
      revision: stream.info.revision,
    });
    const contents = [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: "exact replay text" },
      },
      { kind: "message.completed", payload: { messageId: "m" } },
    ];
    for (const [index, content] of contents.entries())
      await stream.append(lease, [
        {
          protocolVersion: 1,
          streamId: stream.info.id,
          producerEpoch: "epoch",
          producerSeq: index + 1,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock",
          elapsedMs: index * 1000,
          fidelity: "delta",
          source: { agent: "synthetic", sessionId: "native" },
          content,
        } as any,
      ]);
    await stream.buildSnapshot(3);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      text: string,
      callback: (error?: Error) => void,
    ) => {
      output += text;
      callback?.();
      return true;
    }) as any);
    const render = vi.spyOn(PagedTerminalRenderer.prototype, "snapshot");
    try {
      const renew = vi.spyOn(RecordingSnapshotClient.prototype, "renewLease");
      try {
        for (const code of ["stale_lease", "forbidden"] as const) {
          renew.mockRejectedValueOnce(
            new ProtocolError(code, "opening lease failed"),
          );
          output = "";
          const replay = replayRecording({
            serverOrigin: server.url,
            streamId: stream.info.id,
            credential: secret,
            signal: AbortSignal.timeout(10000),
            fromMs: 10000,
          });
          if (code === "stale_lease") {
            await replay;
            expect(output).toContain("exact replay text");
          } else await expect(replay).rejects.toThrow("opening lease failed");
          const ledger = JSON.parse(
            await readFile(
              join(
                directory,
                "sessions",
                stream.info.id,
                "snapshots",
                "leases.json",
              ),
              "utf8",
            ),
          );
          expect(ledger.leases).toEqual([]);
        }
      } finally {
        renew.mockRestore();
      }
      render.mockClear();
      output = "";
      render.mockImplementationOnce(async function* () {
        yield "partial";
        throw new ProtocolError("stale_lease", "expired during text read");
      });
      await replayRecording({
        serverOrigin: server.url,
        streamId: stream.info.id,
        credential: secret,
        signal: AbortSignal.timeout(10000),
        fromMs: 10000,
      });
      expect(output).toContain("partial\n");
      expect(output).toContain("exact replay text");
      expect(render).toHaveBeenCalledTimes(2);
      render.mockClear();
      render.mockImplementationOnce(async function* () {
        throw new ProtocolError("forbidden", "access denied");
      });
      await expect(
        replayRecording({
          serverOrigin: server.url,
          streamId: stream.info.id,
          credential: secret,
          signal: AbortSignal.timeout(10000),
          fromMs: 10000,
        }),
      ).rejects.toThrow("access denied");
      expect(render).toHaveBeenCalledTimes(1);
      render.mockClear();
      write.mockImplementationOnce(((
        text: string,
        callback: (error?: Error) => void,
      ) => {
        callback(new ProtocolError("stale_lease", "sink failed"));
        return false;
      }) as any);
      await expect(
        replayRecording({
          serverOrigin: server.url,
          streamId: stream.info.id,
          credential: secret,
          signal: AbortSignal.timeout(10000),
          fromMs: 10000,
        }),
      ).rejects.toThrow("sink failed");
      expect(render).toHaveBeenCalledTimes(1);
      const applying = vi
        .spyOn(PagedReducer.prototype, "applyBatch")
        .mockRejectedValueOnce(
          new ProtocolError("stale_lease", "expired during reduction"),
        );
      try {
        output = "";
        await replayRecording({
          serverOrigin: server.url,
          streamId: stream.info.id,
          credential: secret,
          signal: AbortSignal.timeout(10000),
        });
        expect(output).toContain("exact replay text");
        expect(applying).toHaveBeenCalledTimes(stream.info.serverSeq + 1);
      } finally {
        applying.mockRestore();
      }
      render.mockClear();
      render.mockImplementation(async function* () {
        throw new ProtocolError("stale_lease", "replacement failed");
      });
      await expect(
        replayRecording({
          serverOrigin: server.url,
          streamId: stream.info.id,
          credential: secret,
          signal: AbortSignal.timeout(10000),
          fromMs: 10000,
        }),
      ).rejects.toThrow("replacement failed");
      expect(render).toHaveBeenCalledTimes(2);
    } finally {
      render.mockRestore();
      write.mockRestore();
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
