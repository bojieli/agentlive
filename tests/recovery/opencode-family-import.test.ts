import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importOpenCodeRecording } from "../../packages/adapters/src/import-opencode.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
const snapshot = (id: string, parent?: string, text = id) => ({
  info: { id, ...(parent ? { parentID: parent } : {}), time: { created: 1 } },
  messages: [
    {
      info: {
        id: "same-message",
        sessionID: id,
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: "same-text",
          sessionID: id,
          messageID: "same-message",
          type: "text",
          text,
        },
        {
          id: "same-file",
          sessionID: id,
          messageID: "same-message",
          type: "file",
          mime: "text/plain",
          filename: "file.txt",
          url:
            "data:text/plain;base64," +
            Buffer.from(`bytes ${id}`).toString("base64"),
        },
      ],
    },
  ],
});
it("imports OpenCode export families and preserves child objects and bytes through archive roundtrip", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "agentlive-opencode-family-import-"),
  );
  const ownerCredential = "c".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const familyRoot = join(root, "exports");
    await mkdir(familyRoot);
    const sourcePath = join(familyRoot, "root.json");
    await writeFile(sourcePath, JSON.stringify(snapshot("root")));
    await writeFile(
      join(familyRoot, "child.json"),
      JSON.stringify(snapshot("child", "root")),
    );
    await writeFile(
      join(familyRoot, "grandchild.json"),
      JSON.stringify(snapshot("grandchild", "child")),
    );
    const options = {
      sourcePath,
      familyRoot,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "OpenCode family",
      visibility: "private" as const,
      signal: AbortSignal.timeout(15000),
    };
    const first = await importOpenCodeRecording(options);
    const retry = await importOpenCodeRecording(options);
    expect(retry.streamId).toBe(first.streamId);
    expect(retry.producerEvents).toBe(first.producerEvents);
    expect(first.report.records).toBe(3);
    expect(first.report.availableAttachments).toBe(3);
    const { rename, readdir } = await import("node:fs/promises");
    const { inspectMigration, relocateImportSources } =
      await import("../../packages/cli/src/inspect-migration.js");
    const bindingDirectory = join(
      options.publisherRoot,
      (await readdir(options.publisherRoot))[0]!,
    );
    const oldInspection = await inspectMigration(bindingDirectory);
    const movedChild = join(familyRoot, "renamed-child.json");
    await rename(join(familyRoot, "child.json"), movedChild);
    await relocateImportSources(bindingDirectory, {
      nativeSource: sourcePath,
      familySources: [`child=${movedChild}`],
      operationId: "move-child",
      expectedManifestHash: oldInspection.imported!.manifestHash,
    });
    const afterRelocation = await importOpenCodeRecording(options);
    expect(afterRelocation).toEqual(first);
    const { migrateImport } =
      await import("../../packages/cli/src/migrate-import.js");
    const replacement = await migrateImport({
      directory: bindingDirectory,
      nativeSource: sourcePath,
      sourceRoot: familyRoot,
      operationId: "opencode-filter-replacement",
      expectedManifestHash: (await inspectMigration(bindingDirectory)).imported!
        .manifestHash,
      disposition: "retain",
      ownerCredential,
      secrets: ["bytes child"],
      signal: options.signal,
    });
    const replacementRecording = await server.store.get(
      replacement.target.streamId,
    );
    try {
      let state = initialState();
      for await (const event of replacementRecording.history(
        0,
        replacementRecording.boundary.sequence,
      ))
        state = apply(state, event);
      const attachments = [...state.artifacts.values()].flatMap((artifact) => [
        ...artifact.versions.values(),
      ]);
      expect(attachments).toHaveLength(3);
      const bytes = [];
      for (const attachment of attachments) {
        const response = await fetch(
          `${server.url}/api/v1/streams/${replacement.target.streamId}/attachments/${attachment.hash}`,
          {
            headers: { authorization: `Bearer ${ownerCredential}` },
          },
        );
        expect(response.status).toBe(200);
        bytes.push(await response.text());
      }
      expect(bytes).not.toContain("bytes child");
      expect(bytes).toContain("bytes root");
      expect(replacementRecording.info.visibility).toBe("private");
    } finally {
      server.store.release(replacementRecording);
    }

    const archive = join(root, "family.agentlive");
    await exportRecording({
      serverOrigin: server.url,
      streamId: first.streamId,
      output: archive,
      credential: ownerCredential,
      signal: options.signal,
    });
    const restored = await importArchiveRecording({
      source: archive,
      serverOrigin: server.url,
      credential: ownerCredential,
      signal: options.signal,
    });
    for (const id of [first.streamId, restored.streamId]) {
      const recording = await server.store.get(id);
      try {
        let state = initialState(),
          starts = 0,
          ends = 0;
        for await (const event of recording.history(
          0,
          recording.boundary.sequence,
        )) {
          state = apply(state, event);
          if (event.content.kind === "session.started") starts++;
          if (event.content.kind === "recording.ended") ends++;
        }
        expect(starts).toBe(1);
        expect(ends).toBe(1);
        expect(
          [...state.messages.values()]
            .map((message) => message.text)
            .filter(Boolean)
            .sort(),
        ).toEqual(["child", "grandchild", "root"]);
        expect(
          [...state.agents.values()].filter((agent) => agent.parentAgentId)
            .length,
        ).toBe(2);
        const attachments = [...state.artifacts.values()].flatMap(
          (artifact) => [...artifact.versions.values()],
        );
        expect(attachments).toHaveLength(3);
        const bytes = [];
        for (const attachment of attachments) {
          const response = await fetch(
            `${server.url}/api/v1/streams/${id}/attachments/${attachment.hash}`,
            { headers: { authorization: `Bearer ${ownerCredential}` } },
          );
          expect(response.status).toBe(200);
          bytes.push(await response.text());
        }
        expect(bytes.sort()).toEqual([
          "bytes child",
          "bytes grandchild",
          "bytes root",
        ]);
      } finally {
        server.store.release(recording);
      }
    }
    const { familyRoot: _family, ...single } = options;
    await expect(importOpenCodeRecording(single)).rejects.toThrow(
      "Import source or options changed",
    );
    await writeFile(
      movedChild,
      JSON.stringify(snapshot("child", "root", "changed")),
    );
    await expect(importOpenCodeRecording(options)).rejects.toThrow(
      "Import source or options changed",
    );
    await writeFile(movedChild, JSON.stringify(snapshot("child", "missing")));
    await expect(importOpenCodeRecording(options)).rejects.toThrow("lineage");
    await writeFile(movedChild, JSON.stringify(snapshot("root")));
    await expect(importOpenCodeRecording(options)).rejects.toThrow(
      "duplicate session exports",
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports frozen incomplete child text and preserves withheld suffixes across import retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-frozen-import-"));
  const ownerCredential = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const familyRoot = join(root, "exports");
    await mkdir(familyRoot);
    const sourcePath = join(familyRoot, "root.json");
    await writeFile(sourcePath, JSON.stringify(snapshot("root")));
    const child = snapshot("child", "root", "Visible secret_pre");
    delete (child.messages[0]!.info.time as { completed?: number }).completed;
    await writeFile(join(familyRoot, "child.json"), JSON.stringify(child));
    const options = {
      sourcePath,
      familyRoot,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Incomplete import",
      visibility: "private" as const,
      secrets: ["secret_prefix"],
      signal: AbortSignal.timeout(15000),
    };
    const first = await importOpenCodeRecording(options);
    expect(first.report).toMatchObject({
      unfinishedMessages: 1,
      withheldTextMessages: 1,
    });
    const retry = await importOpenCodeRecording(options);
    expect(retry.report).toEqual(first.report);
    expect(retry.producerEvents).toBe(first.producerEvents);
    const recording = await server.store.get(first.streamId);
    try {
      let state = initialState(),
        notices = 0;
      for await (const event of recording.history(
        0,
        recording.boundary.sequence,
      )) {
        state = apply(state, event);
        if (event.content.kind === "capture.completeness") notices++;
      }
      expect(notices).toBe(1);
      // Persisted counts only: normalized unfinished messages plus withheld native text.
      expect(state.completeness).toEqual({
        version: 2,
        reason: "frozen-native-source",
        unfinishedMessages: 1,
        unfinishedTools: 0,
        withheldTextMessages: 1,
        runningTasks: 0,
        pendingInteractions: 0,
        pendingAttachments: 0,
        at: expect.any(Number),
      });
      expect(JSON.stringify(state.completeness)).not.toContain("secret");
      expect(
        [...state.messages.values()].some(
          (message) => message.text === "Visible ",
        ),
      ).toBe(true);
      expect(JSON.stringify([...state.messages.values()])).not.toContain(
        "secret_pre",
      );
      expect(recording.info.lifecycle).toBe("ended");
    } finally {
      server.store.release(recording);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
