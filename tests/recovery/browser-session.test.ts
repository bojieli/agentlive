import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../packages/server/dist/index.js";
import { BrowserSession } from "../../apps/web/src/session.js";
import type {
  EventContent,
  PublishedEvent,
} from "../../packages/protocol/src/index.js";

it("serves the browser and keeps receipt independent of pause, seek, leave, and rejoin", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-browser-test-"));
  const server = await startServer({
    directory: root,
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  let viewer: BrowserSession | undefined;
  try {
    for (const [path, type] of [
      ["/", "text/html"],
      ["/app.js", "text/javascript"],
      ["/app.css", "text/css"],
    ]) {
      const asset = await fetch(server.url + path);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain(type);
      expect(asset.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      await asset.arrayBuffer();
    }
    expect((await fetch(server.url + "/package.json")).status).toBe(404);
    const session = await server.store.create({
      ownerId: "local",
      requestId: "browser",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "a".repeat(64),
      title: "Browser integration",
      visibility: "private",
    });
    const { lease } = await session.resume("a".repeat(64), {
      publisherId: "pub",
      producerEpoch: "epoch",
      attempt: 1,
      revision: session.info.revision,
    });
    let sequence = 0;
    const append = async (content: EventContent) => {
      const event: PublishedEvent = {
        protocolVersion: 1,
        streamId: session.info.id,
        producerEpoch: "epoch",
        producerSeq: ++sequence,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock",
        elapsedMs: sequence * 1000,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "browser" },
        content,
      };
      await session.append(lease, [event]);
    };
    await append({
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    });
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: "Before pause" },
    });
    await append({
      kind: "tool.started",
      payload: { toolId: "t", name: "read", input: "example.txt" },
    });
    await append({
      kind: "message.started",
      payload: { messageId: "later", role: "assistant" },
    });
    await expect(
      BrowserSession.open(
        session.info.id,
        "",
        new AbortController().signal,
        () => {},
        server.url,
      ),
    ).rejects.toThrow();
    viewer = await BrowserSession.open(
      session.info.id,
      "b".repeat(64),
      new AbortController().signal,
      () => {},
      server.url,
    );
    await expect
      .poll(() => viewer!.state.messages.get("m")?.text)
      .toBe("Before pause");
    expect(viewer.order("messages/m")).toBeLessThan(viewer.order("tools/t"));
    expect(viewer.order("tools/t")).toBeLessThan(
      viewer.order("messages/later"),
    );
    const prefix = viewer.received;
    viewer.seek(viewer.time);
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: " after pause" },
    });
    await expect.poll(() => viewer!.received).toBe(prefix + 1);
    expect(viewer.state.messages.get("m")?.text).toBe("Before pause");
    viewer.seek(viewer.duration, true);
    expect(viewer.state.messages.get("m")?.text).toBe(
      "Before pause after pause",
    );
    viewer.seek(0);
    expect(viewer.state.messages.get("m")?.text ?? "").toBe("");
    await viewer.close();
    await append({ kind: "message.completed", payload: { messageId: "m" } });
    viewer = await BrowserSession.open(
      session.info.id,
      "b".repeat(64),
      new AbortController().signal,
      () => {},
      server.url,
    );
    await expect
      .poll(() => viewer!.state.messages.get("m")?.completed)
      .toBe(true);
    expect(viewer.state.messages.get("m")?.text).toBe(
      "Before pause after pause",
    );
    expect(viewer.received).toBe(session.boundary.sequence);
    server.store.release(session);
  } finally {
    await viewer?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
