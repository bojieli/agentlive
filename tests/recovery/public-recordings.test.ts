import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import { listRecordings } from "../../packages/client/src/recordings.js";

it("paginates anonymous discovery across owners while excluding private/unlisted metadata and preserving restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-public-list-"));
  let server = await startServer({
    directory: root,
    ownerSecret: "a".repeat(64),
    port: 0,
  });
  const expected: string[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const visibility =
        i % 3 === 0 ? "private" : i % 3 === 1 ? "unlisted" : "public";
      const session = await server.store.create({
        ownerId: `owner-${i % 2}`,
        requestId: `request-${i}`,
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "b".repeat(64),
        title: visibility === "public" ? "Public title" : "HIDDEN_TITLE",
        visibility,
      });
      if (visibility === "public") expected.push(session.info.id);
      server.store.release(session);
    }
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await listRecordings({
        serverOrigin: server.url,
        credential: "",
        public: true,
        limit: 1,
        ...(after ? { after } : {}),
        signal: new AbortController().signal,
      });
      expect(JSON.stringify(page)).not.toContain("HIDDEN_TITLE");
      expect(JSON.stringify(page)).not.toContain("ownerId");
      found.push(...page.recordings.map((recording) => recording.id));
      after = page.nextAfter ?? undefined;
    } while (after);
    expect(found).toEqual(expected.sort());
    expect((await fetch(server.url + "/api/v1/streams")).status).toBe(401);
    expect(
      (await fetch(server.url + "/api/v1/public-recordings?limit=101")).status,
    ).toBe(400);
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: "a".repeat(64),
      port: 0,
    });
    const page = await (
      await fetch(server.url + "/api/v1/public-recordings")
    ).json();
    expect(
      page.recordings.map((recording: { id: string }) => recording.id),
    ).toEqual(expected);
    const stop = new AbortController();
    stop.abort();
    await expect(
      server.store.listPublic({ signal: stop.signal }),
    ).rejects.toThrow();
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
