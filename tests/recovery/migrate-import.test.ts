import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importClaudeRecording } from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { inspectMigration } from "../../packages/cli/src/inspect-migration.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
import { backupServer } from "../../packages/server/src/backup.js";
import { restoreServer } from "../../packages/server/src/restore.js";
import { openArchive } from "../../packages/storage/src/index.js";
import { migrateImport } from "../../packages/cli/src/migrate-import.js";

it.each(["retain", "remove"] as const)(
  "reprojects frozen native history with explicit %s disposition and stable CLI retries",
  async (disposition) => {
    const root = await mkdtemp(join(tmpdir(), "migration-replace-"));
    const credential = "b".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: credential,
      port: 0,
    });
    try {
      const sourcePath = join(root, "source.jsonl");
      const sensitive = "migration-private-value";
      await writeFile(
        sourcePath,
        JSON.stringify({
          type: "user",
          sessionId: "native",
          uuid: "first",
          timestamp: "2026-09-01T00:00:00Z",
          message: { content: `before ${sensitive} after` },
        }) + "\n",
      );
      const original = await importClaudeRecording({
        sourcePath,
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        ownerCredential: credential,
        title: `Migration ${sensitive}`,
        visibility: "public",
        signal: AbortSignal.timeout(10000),
      });
      const journal = await PublisherJournal.open(join(root, "publisher"), {
        serverOrigin: server.url,
        agent: "claude",
        nativeSessionId: "native",
      });
      const directory = journal.directory;
      await journal.close();
      const manifestBefore = await readFile(
        join(directory, "import.json"),
        "utf8",
      );
      const bindingBefore = await readFile(
        join(directory, "binding.json"),
        "utf8",
      );
      const inspection = await inspectMigration(directory);
      const options = {
        directory,
        nativeSource: sourcePath,
        operationId: "replace-one",
        expectedManifestHash: inspection.imported!.manifestHash,
        disposition,
        ownerCredential: credential,
        secrets: [sensitive],
        signal: AbortSignal.timeout(20000),
      };
      if (disposition === "remove") {
        await expect(migrateImport(options)).rejects.toThrow("confirm-removal");
        await expect(
          readFile(join(directory, "replacement-import.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const originalSource = await readFile(sourcePath, "utf8");
      await writeFile(sourcePath, originalSource + "\n");
      await expect(
        migrateImport({ ...options, confirmRemoval: true }),
      ).rejects.toThrow("exact frozen import");
      await expect(
        readFile(join(directory, "replacement-import.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(sourcePath, originalSource);
      const args = [
        "packages/cli/dist/main.js",
        "migrate-import",
        "--source",
        directory,
        "--native-source",
        sourcePath,
        "--operation-id",
        "replace-one",
        "--expected-manifest-hash",
        options.expectedManifestHash,
        "--old-recording",
        disposition,
        "--redact-env",
        "MIGRATION_VALUE",
        ...(disposition === "remove" ? ["--confirm-removal"] : []),
      ];
      const run = () =>
        promisify(execFile)(process.execPath, args, {
          env: {
            ...process.env,
            AGENTLIVE_OWNER_SECRET: credential,
            MIGRATION_VALUE: sensitive,
          },
          timeout: 20000,
        });
      {
        const nativeFetch = globalThis.fetch;
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const response = await nativeFetch(input, init);
            if (
              String(input).endsWith(
                disposition === "remove" ? "/removal" : "/migration-origin",
              ) &&
              response.ok
            ) {
              await response.body?.cancel();
              throw new Error("lost migration response");
            }
            return response;
          });
        try {
          const environmentSecrets = Object.entries({
            ...process.env,
            AGENTLIVE_OWNER_SECRET: credential,
          })
            .filter(
              ([key, value]) =>
                /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) &&
                value &&
                value.length >= 8 &&
                value.length <= 4096,
            )
            .map(([, value]) => value!);
          await expect(
            migrateImport({
              ...options,
              secrets: [...environmentSecrets, sensitive, credential],
              confirmRemoval: true,
            }),
          ).rejects.toThrow("lost migration response");
        } finally {
          fetchSpy.mockRestore();
        }
      }
      const first = await run();
      const receipt = JSON.parse(first.stdout);
      expect(first.stderr).toBe("");
      expect(receipt).toMatchObject({
        event: "import-migrated",
        sourceStreamId: original.streamId,
        disposition,
        completed: true,
        visibility: "private",
      });
      expect(receipt.target.streamId).not.toBe(original.streamId);
      const targetSession = await server.store.get(receipt.target.streamId);
      const events = [];
      for await (const event of targetSession!.history(
        1,
        targetSession!.info.serverSeq,
      ))
        events.push(event);
      expect(JSON.stringify(events)).not.toContain(sensitive);
      expect(JSON.stringify(events)).toContain("before ");
      expect(targetSession!.info.title).not.toContain(sensitive);
      expect(targetSession!.info.visibility).toBe("private");
      expect(targetSession!.info.lifecycle).toBe("ended");
      const remoteOrigin = targetSession!.info.migrationOrigin;
      expect(remoteOrigin).toMatchObject({
        operationId: "replace-one",
        sourceStreamId: original.streamId,
        sourceRevision: original.revision,
        requestedSourceDisposition: disposition,
      });
      const copiedInfo = targetSession!.info;
      copiedInfo.migrationOrigin!.sourceStreamId = "mutated";
      expect(targetSession!.info.migrationOrigin).toEqual(remoteOrigin);
      const targetBinding = JSON.parse(
        await readFile(
          join(receipt.publisherDirectory, "binding.json"),
          "utf8",
        ),
      );
      const lineageUrl = `${server.url}/api/v1/streams/${receipt.target.streamId}/migration-origin`;
      const postOrigin = (
        origin: unknown,
        token: string,
        revision = receipt.target.revision,
      ) =>
        fetch(lineageUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ revision, origin }),
        });
      expect(
        (await postOrigin(remoteOrigin, targetBinding.writeSecret)).status,
      ).toBe(401);
      expect(
        (
          await postOrigin(
            { ...remoteOrigin, sourceStreamId: "different" },
            credential,
          )
        ).status,
      ).toBe(409);
      expect(
        (await postOrigin(remoteOrigin, credential, "stale-revision")).status,
      ).toBe(409);
      server.store.release(targetSession!);
      const archivePath = join(root, "replacement.agentlive");
      await exportRecording({
        serverOrigin: server.url,
        streamId: receipt.target.streamId,
        credential,
        output: archivePath,
        signal: options.signal,
      });
      const archive = await openArchive(archivePath, options.signal);
      expect(archive.manifest.provenance.migrationOrigin).toEqual(remoteOrigin);
      await archive.close();
      const archiveImport = await importArchiveRecording({
        source: archivePath,
        serverOrigin: server.url,
        credential,
        signal: options.signal,
      });
      const restoredSession = await server.store.get(archiveImport.streamId);
      expect(restoredSession.info.migrationOrigin).toEqual(remoteOrigin);
      server.store.release(restoredSession);

      expect((await run()).stdout).toBe(first.stdout);
      expect(await readFile(join(directory, "import.json"), "utf8")).toBe(
        manifestBefore,
      );
      expect(await readFile(join(directory, "binding.json"), "utf8")).toBe(
        bindingBefore,
      );
      const lineage = JSON.parse(
        await readFile(
          join(receipt.publisherDirectory, "migration-origin.json"),
          "utf8",
        ),
      );
      expect(lineage).toMatchObject({
        streamId: original.streamId,
        revision: original.revision,
        disposition,
      });
      expect(JSON.stringify(lineage)).not.toContain(sensitive);
      const oldResponse = await fetch(
        `${server.url}/api/v1/streams/${original.streamId}`,
      );
      expect(oldResponse.status).toBe(disposition === "retain" ? 200 : 404);
      await expect(
        migrateImport({
          ...options,
          confirmRemoval: true,
          secrets: ["different-policy"],
        }),
      ).rejects.toThrow("policy changed");
      // Simulate a lost completion write after target creation and old-recording disposition.
      const intentPath = join(directory, "replacement-import.json");
      const intent = JSON.parse(await readFile(intentPath, "utf8"));
      await writeFile(
        intentPath,
        JSON.stringify({ ...intent, completed: false }),
        { mode: 0o600 },
      );
      expect((await run()).stdout).toBe(first.stdout);
      // Compatibility with replacement journals created before the CLI state layout.
      const legacyDirectory = join(
        receipt.stateDirectory,
        basename(receipt.publisherDirectory),
      );
      await rename(receipt.publisherDirectory, legacyDirectory);
      const legacyIntent = JSON.parse(await readFile(intentPath, "utf8"));
      await writeFile(
        intentPath,
        JSON.stringify({ ...legacyIntent, targetDirectory: legacyDirectory }),
        { mode: 0o600 },
      );
      const legacyRetry = JSON.parse((await run()).stdout);
      expect(legacyRetry.target).toEqual(receipt.target);
      expect(legacyRetry.publisherDirectory).toBe(legacyDirectory);
      expect(legacyRetry.stateDirectory).toBeNull();
      await server.close();
      const ownerFile = join(root, "owner.json");
      await writeFile(
        ownerFile,
        JSON.stringify({ version: 1, secret: credential }),
        { mode: 0o600 },
      );
      const backupPath = join(root, "backup");
      await backupServer({
        directory: join(root, "server"),
        ownerFile,
        output: backupPath,
        signal: options.signal,
      });
      const restoredPath = join(root, "restored");
      await restoreServer({
        source: backupPath,
        output: restoredPath,
        signal: options.signal,
      });
      const restoredMetadata = JSON.parse(
        await readFile(
          join(
            restoredPath,
            "server",
            "sessions",
            receipt.target.streamId,
            "metadata.json",
          ),
          "utf8",
        ),
      );
      expect(restoredMetadata.migrationOrigin).toEqual(remoteOrigin);
      expect(restoredMetadata.revision).not.toBe(receipt.target.revision);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "fences uncertain lineage writes and recovers immutable provenance (installed=%s)",
  async (installed) => {
    const { RecordingStore } =
      await import("../../packages/server/src/store.js");
    const { atomicJson } = await import("../../packages/storage/src/index.js");
    const root = await mkdtemp(join(tmpdir(), "lineage-fault-"));
    let store = await RecordingStore.open(root);
    try {
      const session = await store.create({
        ownerId: "owner",
        requestId: "lineage",
        requestedAt: new Date().toISOString(),
        publisherId: "publisher",
        producerEpoch: "epoch",
        writeSecret: "a".repeat(64),
        title: "Lineage fault",
        visibility: "private",
      });
      const { id, revision } = session.info;
      await session.lifecycle(
        "a".repeat(64),
        "end",
        session.info.lifecycleSeq,
        {
          kind: "recording.ended",
          payload: { producerEpoch: "epoch", throughProducerSeq: 0 },
        },
      );
      const origin = {
        version: 1 as const,
        operationId: "migration",
        sourceStreamId: "source",
        sourceRevision: "revision",
        sourceConverterVersion: "old",
        targetConverterVersion: "new",
        requestedSourceDisposition: "retain" as const,
      };
      const save = vi
        .spyOn(
          session as unknown as { save(metadata: unknown): Promise<void> },
          "save",
        )
        .mockImplementationOnce(async (metadata) => {
          if (installed)
            await atomicJson(
              join(root, "sessions", id, "metadata.json"),
              metadata,
            );
          throw new Error("lineage disk failure");
        });
      await expect(
        session.setMigrationOrigin(revision, origin),
      ).rejects.toThrow("lineage disk failure");
      save.mockRestore();
      await expect(
        session.setMigrationOrigin(revision, {
          ...origin,
          operationId: "different",
        }),
      ).rejects.toMatchObject({ code: "storage_failed" });
      await expect(session.shareEnded("public")).rejects.toMatchObject({
        code: "storage_failed",
      });
      await expect(session.remove("remove", revision)).rejects.toMatchObject({
        code: "storage_failed",
      });
      store.release(session);
      await store.close();
      store = await RecordingStore.open(root);
      const reopened = await store.get(id);
      expect(reopened.info.migrationOrigin).toEqual(
        installed ? origin : undefined,
      );
      expect(await reopened.setMigrationOrigin(revision, origin)).toEqual(
        origin,
      );
      await expect(
        reopened.setMigrationOrigin(revision, {
          ...origin,
          operationId: "different",
        }),
      ).rejects.toMatchObject({ code: "event_conflict" });
      store.release(reopened);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
