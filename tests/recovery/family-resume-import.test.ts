import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  importCodexRecording,
  publishCodexRecording,
  importKimiRecording,
  publishKimiRecording,
  importClaudeRecording,
  publishClaudeRecording,
} from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it.each(["kimi", "claude", "codex"] as const)(
  "continues %s family imports only after validating retained child prefixes",
  async (agent) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-family-resume-"));
    const ownerCredential = "b".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: ownerCredential,
      port: 0,
    });
    const importer =
      agent === "codex"
        ? importCodexRecording
        : agent === "kimi"
          ? importKimiRecording
          : importClaudeRecording;
    const publisher =
      agent === "codex"
        ? publishCodexRecording
        : agent === "kimi"
          ? publishKimiRecording
          : publishClaudeRecording;
    let movedCodexChild: string | undefined;
    let sourceTree = root;
    const path = (child: string) =>
      agent === "codex"
        ? child === "worker" && movedCodexChild
          ? movedCodexChild
          : join(root, "sources", `${child}.jsonl`)
        : agent === "kimi"
          ? join(sourceTree, "session_family", "agents", child, "wire.jsonl")
          : child === "main"
            ? join(sourceTree, "family.jsonl")
            : join(sourceTree, "family", "subagents", `agent-${child}.jsonl`);
    const row = (child: string, text: string) =>
      JSON.stringify(
        agent === "codex"
          ? {
              type: "event_msg",
              timestamp: "2026-09-01T00:00:00Z",
              payload: {
                type: "item_completed",
                item: {
                  id: text,
                  type: "AgentMessage",
                  content: [{ type: "Text", text }],
                },
              },
            }
          : agent === "kimi"
            ? {
                type: "context.append_message",
                time: 2,
                message: { role: "user", content: [{ type: "text", text }] },
              }
            : {
                type: "user",
                sessionId: "family",
                uuid: text,
                timestamp: "2026-09-01T00:00:00Z",
                ...(child === "main"
                  ? {}
                  : { agentId: child, isSidechain: true }),
                message: { content: text },
              },
      ) + "\n";
    const create = async (child: string, text: string) => {
      await mkdir(join(path(child), ".."), { recursive: true });
      await writeFile(
        path(child),
        (agent === "codex"
          ? JSON.stringify({
              type: "session_meta",
              timestamp: "2026-09-01T00:00:00Z",
              payload: {
                id: child === "main" ? "family" : child,
                session_id: "family",
                ...(child === "main" ? {} : { parent_thread_id: "family" }),
                timestamp: "2026-09-01T00:00:00Z",
                cli_version: "test",
              },
            }) + "\n"
          : agent === "kimi"
            ? JSON.stringify({
                type: "metadata",
                protocol_version: "1.5",
                created_at: 1,
              }) + "\n"
            : "") + row(child, text),
      );
    };
    try {
      await create("main", "old main");
      await create("worker", "old child");
      const options = {
        sourcePath: path("main"),
        artifactBaseDirectory: dirname(path("main")),
        artifactRoots: [dirname(path("main"))],
        ...(agent === "codex" ? { familyRoot: join(root, "sources") } : {}),
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        ownerCredential,
        title: "Family resume",
        visibility: "private" as const,
        includeChildren: true,
        signal: AbortSignal.timeout(15000),
      };
      const imported = await importer(options);
      const originalRecording = await server.store.get(imported.streamId);
      const importedEvents = [];
      try {
        for await (const event of originalRecording.history(
          0,
          originalRecording.boundary.sequence,
        ))
          importedEvents.push(event);
      } finally {
        server.store.release(originalRecording);
      }

      // A changed filter creates a separate private projection of the entire family.
      const { readdir } = await import("node:fs/promises");
      const { inspectMigration } =
        await import("../../packages/cli/src/inspect-migration.js");
      const { migrateImport } =
        await import("../../packages/cli/src/migrate-import.js");
      const migrationBinding = join(
        options.publisherRoot,
        (await readdir(options.publisherRoot))[0]!,
      );
      const migrationState = await inspectMigration(migrationBinding);
      const replacement = await migrateImport({
        directory: migrationBinding,
        nativeSource: path("main"),
        ...(agent === "codex" ? { sourceRoot: join(root, "sources") } : {}),
        operationId: "family-replacement",
        expectedManifestHash: migrationState.imported!.manifestHash,
        disposition: "retain",
        ownerCredential,
        secrets: ["old child"],
        signal: options.signal,
      });
      expect(replacement.target.streamId).not.toBe(imported.streamId);
      const projected = await server.store.get(replacement.target.streamId);
      const projectedEvents = [];
      try {
        for await (const event of projected.history(
          0,
          projected.boundary.sequence,
        ))
          projectedEvents.push(event);
        expect(JSON.stringify(projectedEvents)).not.toContain("old child");
        expect(projected.info.lifecycle).toBe("ended");
      } finally {
        server.store.release(projected);
      }

      if (agent === "codex") {
        const { rename, readdir } = await import("node:fs/promises");
        const { inspectMigration, relocateImportSources } =
          await import("../../packages/cli/src/inspect-migration.js");
        const binding = join(
          options.publisherRoot,
          (await readdir(options.publisherRoot))[0]!,
        );
        const inspected = await inspectMigration(binding);
        const oldChild = path("worker");
        movedCodexChild = join(root, "sources", "renamed-worker.jsonl");
        await rename(oldChild, movedCodexChild);
        const relocation = {
          nativeSource: path("main"),
          familySources: [`worker=${movedCodexChild}`],
          operationId: "codex-relocation",
          expectedManifestHash: inspected.imported!.manifestHash,
        };
        await expect(
          relocateImportSources(binding, relocation),
        ).rejects.toThrow("requires --source-root");
        await expect(
          readFile(join(binding, "relocate-import.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await relocateImportSources(binding, {
          ...relocation,
          sourceRoot: join(root, "sources"),
        });
      }

      if (agent !== "codex") {
        const { rename, readdir } = await import("node:fs/promises");
        const { inspectMigration, relocateImportSources } =
          await import("../../packages/cli/src/inspect-migration.js");
        const binding = join(
          options.publisherRoot,
          (await readdir(options.publisherRoot))[0]!,
        );
        const inspected = await inspectMigration(binding);
        sourceTree = join(root, "relocated-native");
        await mkdir(sourceTree);
        if (agent === "kimi") {
          await rename(
            join(root, "session_family"),
            join(sourceTree, "session_family"),
          );
          // Artifact roots are a separate policy: retain the explicitly selected directory.
          await mkdir(options.artifactBaseDirectory, { recursive: true });
        } else {
          await rename(join(root, "family.jsonl"), path("main"));
          await rename(join(root, "family"), join(sourceTree, "family"));
        }
        options.sourcePath = path("main");
        await relocateImportSources(binding, {
          nativeSource: options.sourcePath,
          familySources: [`worker=${path("worker")}`],
          operationId: `${agent}-relocation`,
          expectedManifestHash: inspected.imported!.manifestHash,
        });
      }
      const state = async () => {
        const recording = await server.store.get(imported.streamId);
        try {
          let value = initialState(),
            reopens = 0;
          for await (const event of recording.history(
            0,
            recording.boundary.sequence,
          )) {
            value = apply(value, event);
            if (event.content.kind === "recording.reopened") reopens++;
          }
          return {
            texts: [...value.messages.values()]
              .map((message) => message.text)
              .filter(Boolean)
              .sort(),
            reopens,
          };
        } finally {
          server.store.release(recording);
        }
      };
      const original = await readFile(path("worker"), "utf8");
      await writeFile(
        path("worker"),
        original.replace("old child", "BAD child"),
      );
      await expect(
        publisher({ ...options, resumeImport: true }),
      ).rejects.toThrow("prefix changed");
      expect((await state()).reopens).toBe(0);
      await rm(path("worker"));
      await expect(
        publisher({ ...options, resumeImport: true }),
      ).rejects.toThrow();
      expect((await state()).reopens).toBe(0);
      await writeFile(path("worker"), original);
      if (agent === "codex") {
        await expect(
          publishCodexRecording({
            ...options,
            resumeImport: true,
            recordFormat: "legacy",
          }),
        ).rejects.toThrow("legacy");
        expect((await state()).reopens).toBe(0);
        await writeFile(
          path("worker"),
          original.replace(
            '"parent_thread_id":"family"',
            '"parent_thread_id":"missing"',
          ),
        );
        await expect(
          publishCodexRecording({ ...options, resumeImport: true }),
        ).rejects.toThrow("lineage");
        expect((await state()).reopens).toBe(0);
        await writeFile(path("worker"), original);
      }
      await expect(
        publisher({
          ...options,
          resumeImport: true,
          includeChildren: false,
          ...(agent === "codex" ? { familyRoot: undefined } : {}),
        }),
      ).rejects.toThrow("options differ");
      expect((await state()).reopens).toBe(0);
      await appendFile(path("worker"), row("worker", "new child"));
      await appendFile(path("main"), row("main", "new main"));
      await create("late", "late child");
      const expected = [
        "late child",
        "new child",
        "new main",
        "old child",
        "old main",
      ].sort();
      for (let attempt = 0; attempt < 2; attempt++) {
        let finish = false;
        await publisher({
          ...options,
          resumeImport: attempt === 0,
          finishRequested: () => finish,
          onCaughtUp: async () => {
            await expect
              .poll(async () => (await state()).texts, { timeout: 5000 })
              .toEqual(expected);
            finish = true;
          },
        });
        expect((await state()).reopens).toBe(1);
        const recording = await server.store.get(imported.streamId);
        try {
          const preserved = [];
          for await (const event of recording.history(0, importedEvents.length))
            preserved.push(event);
          expect(preserved).toEqual(importedEvents);
        } finally {
          server.store.release(recording);
        }
      }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps an imported child checkpoint intact when converter reconstruction fails", async () => {
  const { createHash } = await import("node:crypto");
  const { PublisherJournal } =
    await import("../../packages/publisher/src/index.js");
  const { kimiFamilyFollower } =
    await import("../../packages/adapters/src/kimi-family.js");
  const { inspectKimiHistory } =
    await import("../../packages/adapters/src/kimi-history.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-child-checkpoint-"));
  let journal: Awaited<ReturnType<typeof PublisherJournal.open>> | undefined;
  try {
    const familyRoot = join(root, "session_family");
    const metadata =
      JSON.stringify({
        type: "metadata",
        protocol_version: "1.5",
        created_at: 1,
      }) + "\n";
    const message = (text: string) =>
      JSON.stringify({
        type: "context.append_message",
        time: 2,
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";
    for (const agent of ["main", "worker"]) {
      const directory = join(familyRoot, "agents", agent);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "wire.jsonl"),
        metadata + message("first") + message("second"),
      );
    }
    const childPath = join(familyRoot, "agents", "worker", "wire.jsonl");
    const manifest = await inspectKimiHistory(childPath);
    journal = await PublisherJournal.open(join(root, "publisher"), {
      agent: "kimi",
      nativeSessionId: "family",
      serverOrigin: "http://localhost",
    });
    await journal.bindRemote("stream", "revision");
    const checkpoint = join(
      journal.directory,
      `kimi-child-${createHash("sha256").update("worker").digest("hex")}.json`,
    );
    await writeFile(checkpoint, JSON.stringify(manifest.boundary));
    const capture = journal.capture.bind(journal);
    journal.capture = async (input) => {
      if (
        input.content.some(
          (content) =>
            content.kind === "message.reconciled" &&
            content.payload.text === "second",
        )
      )
        throw new Error("Interrupted reconstruction");
      return capture(input);
    };
    const follower = kimiFamilyFollower(familyRoot, "family", {
      journal,
      sourcePath: join(familyRoot, "agents", "main", "wire.jsonl"),
      signal: AbortSignal.timeout(5000),
      secrets: [],
      artifacts: {} as any,
      onCaughtUp: async () => {},
      onRecordCommitted: async () => {},
    });
    await expect(follower()).rejects.toThrow("Interrupted reconstruction");
    expect(JSON.parse(await readFile(checkpoint, "utf8"))).toEqual(
      manifest.boundary,
    );
  } finally {
    await journal?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not reopen a Codex family when a child imported legacy content conflicts with structured capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-codex-format-resume-"));
  const ownerCredential = "d".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const familyRoot = join(root, "sources");
    await mkdir(familyRoot);
    const timestamp = "2026-09-01T00:00:00Z";
    const metadata = (id: string, parent?: string) =>
      JSON.stringify({
        type: "session_meta",
        timestamp,
        payload: {
          id,
          session_id: "family",
          parent_thread_id: parent,
          timestamp,
          cli_version: "test",
        },
      }) + "\n";
    const sourcePath = join(familyRoot, "root.jsonl");
    await writeFile(sourcePath, metadata("family"));
    await writeFile(
      join(familyRoot, "child.jsonl"),
      metadata("child", "family") +
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            type: "message",
            id: "legacy-message",
            role: "assistant",
            content: [{ type: "output_text", text: "legacy child" }],
          },
        }) +
        "\n",
    );
    const options = {
      sourcePath,
      familyRoot,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Legacy family",
      visibility: "private" as const,
      signal: AbortSignal.timeout(10000),
    };
    const imported = await importCodexRecording(options);
    await expect(
      publishCodexRecording({
        ...options,
        resumeImport: true,
        recordFormat: "structured",
      }),
    ).rejects.toThrow("imported Codex family prefix");
    const recording = await server.store.get(imported.streamId);
    try {
      const kinds = [];
      for await (const event of recording.history(
        0,
        recording.boundary.sequence,
      ))
        kinds.push(event.content.kind);
      expect(kinds).not.toContain("recording.reopened");
    } finally {
      server.store.release(recording);
    }
    let finish = false;
    await publishCodexRecording({
      ...options,
      resumeImport: true,
      recordFormat: "legacy",
      onCaughtUp: async () => {
        finish = true;
      },
      finishRequested: () => finish,
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
