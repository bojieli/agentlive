import { expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishCodexRecording } from "../../packages/adapters/src/publish-codex.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";

it("captures explicit Codex descendants into one journal and resumes child cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-codex-family-"));
  const owner = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: owner,
    port: 0,
  });
  const timestamp = "2026-09-01T00:00:00Z";
  const metadata = (id: string, parent?: string) =>
    JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: {
        id,
        session_id: "root",
        parent_thread_id: parent,
        timestamp,
        cli_version: "test",
      },
    }) + "\n";
  const message = (text: string, id = "shared") =>
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "item_completed",
        item: { id, type: "AgentMessage", content: [{ type: "Text", text }] },
      },
    }) + "\n";
  const sources = join(root, "sources");
  await mkdir(sources);
  try {
    await writeFile(
      join(sources, "root.jsonl"),
      metadata("root") + message("root text"),
    );
    await writeFile(
      join(sources, "child.jsonl"),
      metadata("child", "root") + metadata("root") + message("child text"),
    );
    await writeFile(
      join(sources, "grandchild.jsonl"),
      metadata("grandchild", "child") +
        metadata("child", "root") +
        metadata("root") +
        message("grandchild text"),
    );
    const options = {
      sourcePath: join(sources, "root.jsonl"),
      familyRoot: sources,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: owner,
      title: "Family",
      visibility: "private" as const,
    };
    let baseline = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2)
        await appendFile(
          join(sources, "child.jsonl"),
          message("later text", "later"),
        );
      let finish = false;
      await publishCodexRecording({
        ...options,
        signal: AbortSignal.timeout(10000),
        onCaughtUp: async () => {
          finish = true;
        },
        finishRequested: () => finish,
      });
      const journal = await PublisherJournal.open(options.publisherRoot, {
        serverOrigin: server.url,
        agent: "codex",
        nativeSessionId: "root",
      });
      try {
        const events = [];
        for await (const event of journal.pending(0))
          events.push(event.content);
        expect(
          events.filter((event) => event.kind === "session.started"),
        ).toHaveLength(1);
        const texts = events
          .filter((event) => event.kind === "message.reconciled")
          .map((event) => event.payload.text);
        expect(texts.sort()).toEqual(
          [
            "root text",
            "child text",
            "grandchild text",
            ...(attempt === 2 ? ["later text"] : []),
          ].sort(),
        );
        if (attempt === 1) expect(journal.capturedThrough).toBe(baseline);
        baseline = journal.capturedThrough;
      } finally {
        await journal.close();
      }
    }
    await expect(
      publishCodexRecording({
        ...options,
        familyRoot: root,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("options changed");
    await writeFile(
      join(sources, "child.jsonl"),
      metadata("child", "foreign") + message("rewritten"),
    );
    await expect(
      publishCodexRecording({ ...options, signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow(/lineage/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
