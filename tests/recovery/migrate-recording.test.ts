import { it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../../packages/server/src/http.js";
import {
  PublisherJournal,
  PublisherNetwork,
  finishPublisher,
  assertPublisherNotFinished,
} from "../../packages/publisher/src/index.js";
import { migrateRecording } from "../../packages/cli/src/migrate-recording.js";

it.each(["retain", "remove"] as const)(
  "finishes and migrates a captured recording without native files (%s)",
  async (disposition) => {
    const root = await mkdtemp(join(tmpdir(), "archive-transfer-"));
    const sourceSecret = "a".repeat(64),
      targetSecret = "b".repeat(64);
    const source = await startServer({
      directory: join(root, "source"),
      ownerSecret: sourceSecret,
      port: 0,
    });
    const destination = await startServer({
      directory: join(root, "destination"),
      ownerSecret: targetSecret,
      port: 0,
    });
    let journal: PublisherJournal | undefined;
    try {
      const signal = AbortSignal.timeout(25000);
      journal = await PublisherJournal.open(join(root, "publisher"), {
        serverOrigin: source.url,
        agent: "claude",
        nativeSessionId: "gone-native",
      });
      const directory = journal.directory;
      const network = new PublisherNetwork({
        journal,
        ownerCredential: sourceSecret,
        title: "Recorded history",
        visibility: "private",
      });
      await network.ensureRemote(signal);
      const sourceId = journal.identity.streamId!;
      const session = await source.store.get(sourceId);
      const bytes = Buffer.from("original captured artifact bytes");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const attachment = {
        artifactId: "artifact",
        version: 1,
        filename: "result.txt",
        mediaType: "text/plain",
        hash,
        byteSize: bytes.length,
      };
      await session.uploadAttachment(
        journal.identity.writeSecret,
        attachment,
        (async function* () {
          yield bytes;
        })(),
      );
      source.store.release(session);
      await journal.capture({
        sourceKey: "captured",
        observedAt: "2026-09-01T00:00:00Z",
        clockSegmentId: "clock",
        elapsedMs: 0,
        fidelity: "delta",
        adapterState: null,
        content: [
          {
            kind: "message.started",
            payload: { messageId: "m", role: "assistant" },
          },
          {
            kind: "message.text.append",
            payload: { messageId: "m", text: "recorded exact text" },
          },
          { kind: "attachment.available", payload: { attachment } },
        ],
      });
      expect(journal.identity.acknowledgedSeq).toBe(0);
      await journal.close();
      journal = undefined;
      const options = {
        directory,
        operationId: "transfer",
        targetServerOrigin: destination.url,
        sourceCredential: sourceSecret,
        targetCredential: targetSecret,
        disposition,
        confirmRemoval: true,
        signal,
      };
      await expect(migrateRecording(options)).rejects.toThrow("drain");
      await expect(
        readFile(join(directory, "archive-transfer.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const nativeFetch = globalThis.fetch;
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const response = await nativeFetch(input, init);
          if (String(input).endsWith("/end") && response.ok) {
            await response.body?.cancel();
            throw new Error("lost finish response");
          }
          return response;
        });
      try {
        await expect(
          finishPublisher({
            directory,
            operationId: "finish",
            ownerCredential: sourceSecret,
            signal,
          }),
        ).rejects.toThrow("lost finish response");
      } finally {
        spy.mockRestore();
      }
      const cli = (args: string[]) =>
        promisify(execFile)(
          process.execPath,
          ["packages/cli/dist/main.js", ...args],
          {
            env: { ...process.env, AGENTLIVE_OWNER_SECRET: sourceSecret },
            timeout: 20000,
          },
        );
      const finishArgs = [
        "finish-publisher",
        "--source",
        directory,
        "--operation-id",
        "finish",
      ];
      const finished = await cli(finishArgs);
      expect(JSON.parse(finished.stdout)).toMatchObject({
        producerEvents: 3,
        completed: true,
      });
      expect((await cli(finishArgs)).stdout).toBe(finished.stdout);
      await expect(assertPublisherNotFinished(directory)).rejects.toThrow(
        "finish",
      );
      const ended = await source.store.get(sourceId);
      const original = [];
      for await (const event of ended.history(0, ended.boundary.sequence))
        original.push(event);
      expect(ended.info.lifecycle).toBe("ended");
      const originalRevision = ended.info.revision;
      source.store.release(ended);
      const targetOwner = join(root, "destination-owner.json");
      await writeFile(
        targetOwner,
        JSON.stringify({ version: 1, secret: targetSecret }),
        { mode: 0o600 },
      );
      const transferArgs = [
        "migrate-recording",
        "--source",
        directory,
        "--operation-id",
        "transfer",
        "--target-server",
        destination.url,
        "--target-owner-file",
        targetOwner,
        "--old-recording",
        disposition,
        ...(disposition === "remove" ? ["--confirm-removal"] : []),
      ];
      const lostImport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const response = await nativeFetch(input, init);
          if (
            String(input) === destination.url + "/api/v1/imports" &&
            response.ok
          ) {
            await response.body?.cancel();
            throw new Error("lost archive import response");
          }
          return response;
        });
      try {
        await expect(migrateRecording(options)).rejects.toThrow(
          "lost archive import response",
        );
      } finally {
        lostImport.mockRestore();
      }
      await expect(
        source.store.remove({
          id: sourceId,
          revision: originalRevision,
          operationId: "stale-export",
          operator: true,
          expectedServerSeq: original.length - 1,
        }),
      ).rejects.toMatchObject({ code: "precondition_failed" });
      const transferred = await cli(transferArgs);
      const receipt = JSON.parse(transferred.stdout);
      expect(receipt).toMatchObject({
        sourceStreamId: sourceId,
        completed: true,
        targetServerOrigin: destination.url,
      });
      expect((await cli(transferArgs)).stdout).toBe(transferred.stdout);
      const target = await destination.store.get(receipt.target.streamId);
      const copied = [];
      for await (const event of target.history(0, target.boundary.sequence))
        copied.push(event);
      const projection = (events: typeof original) =>
        events.map(({ serverSeq, receivedAt, timelineMs, content }) => ({
          serverSeq,
          receivedAt,
          timelineMs,
          content,
        }));
      expect(projection(copied)).toEqual(projection(original));
      expect(target.info.archiveOrigin).toEqual({
        serverOrigin: source.url,
        streamId: sourceId,
        revision: originalRevision,
        throughServerSeq: original.length,
      });
      expect(target.info.visibility).toBe("private");
      const file = await target.openAttachment(hash);
      expect(await file.readFile()).toEqual(bytes);
      await file.close();
      destination.store.release(target);
      expect(
        (
          await fetch(`${source.url}/api/v1/streams/${sourceId}`, {
            headers: { authorization: `Bearer ${sourceSecret}` },
          })
        ).status,
      ).toBe(disposition === "remove" ? 404 : 200);
      await expect(
        migrateRecording({
          ...options,
          targetServerOrigin: "http://127.0.0.1:1",
        }),
      ).rejects.toThrow("differs from saved intent");
    } finally {
      await journal?.close();
      await source.close();
      await destination.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
