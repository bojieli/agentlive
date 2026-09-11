import {
  importClaudeRecording,
  publishClaudeRecording,
  importCodexRecording,
  publishCodexRecording,
} from "../../packages/adapters/src/index.js";
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKimiRecording } from "../../packages/adapters/src/import-kimi.js";
import { publishKimiRecording } from "../../packages/adapters/src/publish-kimi.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { isFileFamilyExpansion } from "../../packages/adapters/src/expand-family.js";
it.each(
  (["kimi", "claude", "codex"] as const).flatMap((native) =>
    [false, true].map((imported) => ({ native, imported })),
  ),
)(
  "expands a live recording without replacing its prefix or accepting policy changes (%j)",
  async ({ native, imported }) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-expand-family-"));
    const ownerCredential = "a".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: ownerCredential,
      port: 0,
    });
    try {
      const path = (agent: string) =>
        native === "kimi"
          ? join(root, "session_family", "agents", agent, "wire.jsonl")
          : native === "claude"
            ? agent === "main"
              ? join(root, "family.jsonl")
              : join(root, "family", "subagents", `agent-${agent}.jsonl`)
            : join(root, "sources", `${agent}.jsonl`);
      for (const agent of ["main", "worker"]) {
        await mkdir(join(path(agent), ".."), { recursive: true });
        const timestamp = "2026-09-01T00:00:00Z";
        const rows =
          native === "kimi"
            ? [
                { type: "metadata", protocol_version: "1.5", created_at: 1 },
                {
                  type: "context.append_message",
                  time: 2,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: agent }],
                  },
                },
              ]
            : native === "claude"
              ? [
                  {
                    type: "user",
                    sessionId: "family",
                    uuid: agent,
                    timestamp,
                    ...(agent === "worker"
                      ? { agentId: agent, isSidechain: true }
                      : {}),
                    message: { content: agent },
                  },
                ]
              : [
                  {
                    type: "session_meta",
                    timestamp,
                    payload: {
                      id: agent === "main" ? "family" : agent,
                      session_id: "family",
                      ...(agent === "worker"
                        ? { parent_thread_id: "family" }
                        : {}),
                      timestamp,
                      cli_version: "test",
                    },
                  },
                  {
                    type: "event_msg",
                    timestamp,
                    payload: {
                      type: "item_completed",
                      item: {
                        id: agent,
                        type: "AgentMessage",
                        content: [{ type: "Text", text: agent }],
                      },
                    },
                  },
                ];
        await writeFile(
          path(agent),
          rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
      }
      const publisher =
        native === "kimi"
          ? publishKimiRecording
          : native === "claude"
            ? publishClaudeRecording
            : publishCodexRecording;
      const importer =
        native === "kimi"
          ? importKimiRecording
          : native === "claude"
            ? importClaudeRecording
            : importCodexRecording;
      const options = {
        sourcePath: path("main"),
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        ownerCredential,
        title: "Family",
        visibility: "private" as const,
        signal: AbortSignal.timeout(10000),
      };
      const run = async (extra: {
        includeChildren?: boolean;
        expandFamily?: boolean;
        resumeImport?: boolean;
        title?: string;
      }) => {
        let finish = false;
        await publisher({
          ...options,
          ...(native === "codex" && extra.includeChildren
            ? { familyRoot: join(root, "sources") }
            : {}),
          ...extra,
          onCaughtUp: async () => {
            finish = true;
          },
          finishRequested: () => finish,
        });
      };
      const read = async () => {
        const journal = await PublisherJournal.open(options.publisherRoot, {
          agent: native,
          nativeSessionId: "family",
          serverOrigin: server.url,
        });
        try {
          const events = [];
          for await (const event of journal.pending(0)) events.push(event);
          return {
            id: journal.identity.streamId,
            directory: journal.directory,
            events,
          };
        } finally {
          await journal.close();
        }
      };
      await expect(
        run({ includeChildren: true, expandFamily: true }),
      ).rejects.toThrow("existing live file publication");
      if (imported) {
        await importer(options);
        await expect(
          run({ includeChildren: true, expandFamily: true }),
        ).rejects.toThrow("Resume the original single-session import");
        await run({ resumeImport: true });
      } else await run({});
      const before = await read();
      await expect(run({ includeChildren: true })).rejects.toThrow(
        imported ? "options differ" : "options changed",
      );
      await expect(
        run({ includeChildren: true, expandFamily: true, title: "Changed" }),
      ).rejects.toThrow(imported ? "capture policies" : "options changed");
      await run({ includeChildren: true, expandFamily: true });
      const after = await read();
      expect(after.id).toBe(before.id);
      expect(after.events.slice(0, before.events.length)).toEqual(
        before.events,
      );
      expect(
        after.events.filter(
          (event) => event.content.kind === "session.started",
        ),
      ).toHaveLength(1);
      expect(
        after.events
          .filter((event) => event.content.kind === "message.reconciled")
          .map((event) =>
            event.content.kind === "message.reconciled"
              ? event.content.payload.text
              : "",
          )
          .sort(),
      ).toEqual(["main", "worker"]);
      if (imported) {
        const marker = JSON.parse(
          await readFile(
            join(after.directory, "import-family-expansion.json"),
            "utf8",
          ),
        );
        // Simulate interruption after the authorization record but before manifest upgrade.
        await writeFile(
          join(after.directory, "publish.json"),
          JSON.stringify(marker.original),
        );
      }
      await run({ includeChildren: true });
      expect(await read()).toEqual(after);
      await expect(run({ expandFamily: true })).rejects.toThrow(
        imported ? "capture policies" : "options changed",
      );
      if (imported) {
        const markerPath = join(
          after.directory,
          "import-family-expansion.json",
        );
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.importHash = "0".repeat(64);
        await writeFile(markerPath, JSON.stringify(marker));
        await expect(run({ includeChildren: true })).rejects.toThrow(
          "expansion identity changed",
        );
      }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("allows only compatible main-to-family converter transitions", () => {
  for (const [from, to] of [
    ["claude-history-4", "claude-history-4-family-1"],
    ["kimi-history-4-main", "kimi-history-4-main-family-1"],
    ["codex-history-4", "codex-history-4-family-1"],
  ]) {
    const previous = {
      converterVersion: from,
      filter: "same",
      roots: ["/root"],
    };
    const next = {
      ...previous,
      converterVersion: to,
      ...(from === "codex-history-4" ? { familyRoot: "/root" } : {}),
    };
    expect(isFileFamilyExpansion(previous, next)).toBe(true);
    expect(
      isFileFamilyExpansion(previous, { ...next, filter: "changed" }),
    ).toBe(false);
    expect(isFileFamilyExpansion(next, previous)).toBe(false);
  }
});
