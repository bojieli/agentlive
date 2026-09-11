import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../../packages/server/src/http.js";
import { importClaudeRecording } from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { inspectMigration } from "../../packages/cli/src/inspect-migration.js";
import { migrateImport } from "../../packages/cli/src/migrate-import.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { openArchive } from "../../packages/storage/src/index.js";

it.each(["retain", "remove"] as const)(
  "migrates frozen imports between servers with separate credentials and %s disposition",
  async (disposition) => {
    const root = await mkdtemp(join(tmpdir(), "server-migration-"));
    const sourceCredential = "a".repeat(64),
      targetCredential = "b".repeat(64);
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
      const sourcePath = join(root, "native.jsonl");
      await writeFile(
        sourcePath,
        JSON.stringify({
          type: "user",
          sessionId: "native",
          uuid: "row",
          timestamp: "2026-09-01T00:00:00Z",
          message: {
            content: `migrated text ${sourceCredential} ${targetCredential}`,
          },
        }) + "\n",
      );
      const imported = await importClaudeRecording({
        sourcePath,
        publisherRoot: join(root, "publisher"),
        serverOrigin: sourceServer.url,
        ownerCredential: sourceCredential,
        title: "Server migration",
        visibility: "private",
        signal: AbortSignal.timeout(10000),
      });
      const journal = await PublisherJournal.open(join(root, "publisher"), {
        serverOrigin: sourceServer.url,
        agent: "claude",
        nativeSessionId: "native",
      });
      const directory = journal.directory;
      await journal.close();
      const inspected = await inspectMigration(directory);
      const options = {
        directory,
        nativeSource: sourcePath,
        operationId: "move-server",
        expectedManifestHash: inspected.imported!.manifestHash,
        disposition,
        confirmRemoval: true,
        ownerCredential: sourceCredential,
        targetServerOrigin: targetServer.url,
        signal: AbortSignal.timeout(20000),
      };
      await expect(migrateImport(options)).rejects.toThrow(
        "separate destination credential",
      );
      await expect(
        migrateImport({ ...options, targetOwnerCredential: sourceCredential }),
      ).rejects.toThrow();
      await expect(
        readFile(join(directory, "replacement-import.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const sourceBinding = await readFile(
        join(directory, "binding.json"),
        "utf8",
      );
      const targetOwnerFile = join(root, "destination-owner.json");
      await writeFile(
        targetOwnerFile,
        JSON.stringify({ version: 1, secret: targetCredential }),
        { mode: 0o600 },
      );
      const args = [
        "packages/cli/dist/main.js",
        "migrate-import",
        "--source",
        directory,
        "--native-source",
        sourcePath,
        "--operation-id",
        options.operationId,
        "--expected-manifest-hash",
        options.expectedManifestHash,
        "--old-recording",
        disposition,
        "--target-server",
        targetServer.url,
        "--target-owner-file",
        targetOwnerFile,
        ...(disposition === "remove" ? ["--confirm-removal"] : []),
      ];
      const run = () =>
        promisify(execFile)(process.execPath, args, {
          env: { ...process.env, AGENTLIVE_OWNER_SECRET: sourceCredential },
          timeout: 20000,
        });
      const first = await run();
      const receipt = JSON.parse(first.stdout);
      expect(receipt).toMatchObject({
        completed: true,
        sourceStreamId: imported.streamId,
        targetServerOrigin: targetServer.url,
        visibility: "private",
      });
      expect((await run()).stdout).toBe(first.stdout);
      expect(await readFile(join(directory, "binding.json"), "utf8")).toBe(
        sourceBinding,
      );
      await expect(
        migrateImport({
          ...options,
          targetOwnerCredential: targetCredential,
          targetServerOrigin: "http://127.0.0.1:1",
        }),
      ).rejects.toThrow("differs from saved migration");
      const target = await targetServer.store.get(receipt.target.streamId);
      const events = [];
      for await (const event of target.history(0, target.boundary.sequence))
        events.push(event);
      expect(JSON.stringify(events)).toContain("migrated text");
      expect(JSON.stringify(events)).not.toContain(sourceCredential);
      expect(JSON.stringify(events)).not.toContain(targetCredential);
      const origin = target.info.migrationOrigin!;
      expect(origin.externalSource).toEqual({
        serverOrigin: sourceServer.url,
        verification: "owner-declared",
      });
      const copied = target.info.migrationOrigin!;
      copied.externalSource!.serverOrigin = "https://changed.example";
      expect(target.info.migrationOrigin).toEqual(origin);
      expect(target.info.visibility).toBe("private");
      targetServer.store.release(target);
      const path = `/api/v1/streams/${receipt.target.streamId}`;
      expect(
        (
          await fetch(targetServer.url + path, {
            headers: { authorization: `Bearer ${sourceCredential}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(
            sourceServer.url + `/api/v1/streams/${imported.streamId}`,
            { headers: { authorization: `Bearer ${sourceCredential}` } },
          )
        ).status,
      ).toBe(disposition === "remove" ? 404 : 200);
      const archivePath = join(root, "migrated.agentlive");
      await exportRecording({
        serverOrigin: targetServer.url,
        streamId: receipt.target.streamId,
        credential: targetCredential,
        output: archivePath,
        signal: options.signal,
      });
      const archive = await openArchive(archivePath, options.signal);
      expect(archive.manifest.provenance.migrationOrigin).toEqual(origin);
      await archive.close();
      expect(receipt.stateDirectory).toBeTruthy();
      for (const restart of [false, true]) {
        const text = restart
          ? "destination restart"
          : "destination continuation";
        await appendFile(
          sourcePath,
          JSON.stringify({
            type: "user",
            sessionId: "native",
            uuid: text,
            timestamp: "2026-09-01T00:00:01Z",
            message: { content: text },
          }) + "\n",
        );
        const publisher = spawn(
          process.execPath,
          [
            "packages/cli/dist/main.js",
            "publish",
            "--agent",
            "claude",
            "--source",
            sourcePath,
            "--server",
            targetServer.url,
            "--state-dir",
            receipt.stateDirectory,
            "--title",
            "Server migration",
            ...(restart ? [] : ["--resume-import"]),
          ],
          {
            env: {
              ...process.env,
              AGENTLIVE_OWNER_SECRET: targetCredential,
              AGENTLIVE_SOURCE_SECRET: sourceCredential,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "",
          errors = "";
        publisher.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        publisher.stderr.on("data", (chunk) => {
          errors += String(chunk);
        });
        const exited = new Promise((resolve, reject) => {
          publisher.once("close", resolve);
          publisher.once("error", reject);
        });
        try {
          await expect
            .poll(
              () => {
                if (errors) throw new Error(errors);
                return output;
              },
              { timeout: 10000 },
            )
            .toContain('"event":"source-caught-up"');
          expect(output).toContain(receipt.target.streamId);
          await expect
            .poll(
              async () => {
                const recording = await targetServer.store.get(
                  receipt.target.streamId,
                );
                try {
                  const current = [];
                  for await (const event of recording.history(
                    0,
                    recording.boundary.sequence,
                  ))
                    current.push(event);
                  expect(current.slice(0, events.length)).toEqual(events);
                  return JSON.stringify(current);
                } finally {
                  targetServer.store.release(recording);
                }
              },
              { timeout: 10000 },
            )
            .toContain(text);
        } finally {
          publisher.kill("SIGTERM");
          await exited;
        }
      }
    } finally {
      await sourceServer.close();
      await targetServer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
