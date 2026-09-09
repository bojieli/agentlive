import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../packages/server/dist/index.js";
import {
  ForegroundClock,
  bindPageLifecycle,
} from "../../apps/web/src/lifecycle.js";
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
    viewer.setActive(false);
    await expect.poll(() => viewer!.status).toBe("suspended");
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: " after pause" },
    });
    expect(viewer.received).toBe(prefix);
    viewer.reconnect(); // Online/focus hints must not resume hidden receipt.
    expect(viewer.status).toBe("suspended");
    for (let index = 0; index < 50; index++) {
      viewer.setActive(true);
      viewer.reconnect();
      viewer.setActive(false);
    }
    viewer.setActive(true);
    await expect.poll(() => viewer!.received).toBe(prefix + 1);
    expect(viewer.error).toBe("");
    expect(viewer.follow).toBe(false);
    expect(viewer.state.messages.get("m")?.text).toBe("Before pause");
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: " live" },
    });
    await expect.poll(() => viewer!.received).toBe(prefix + 2);
    expect(viewer.state.messages.get("m")?.text).toBe("Before pause");
    viewer.seek(viewer.duration, true);
    expect(viewer.state.messages.get("m")?.text).toBe(
      "Before pause after pause live",
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
      "Before pause after pause live",
    );
    expect(viewer.received).toBe(session.boundary.sequence);
    server.store.release(session);
  } finally {
    await viewer?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["b", "c"])(
  "revalidates authorization after suspension with server credential %s",
  async (serverCredential) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-browser-restart-"));
    let server = await startServer({
      directory: root,
      ownerSecret: "b".repeat(64),
      port: 0,
    });
    let viewer: BrowserSession | undefined;
    try {
      const recording = await server.store.create({
        ownerId: "local",
        requestId: "restart",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "a".repeat(64),
        title: "Restart",
        visibility: "private",
      });
      const id = recording.info.id;
      server.store.release(recording);
      viewer = await BrowserSession.open(
        id,
        "b".repeat(64),
        new AbortController().signal,
        () => {},
        server.url,
      );
      await expect.poll(() => viewer!.status).toBe("live");
      viewer.seek(viewer.time);
      const prefix = viewer.received;
      viewer.setActive(false);
      await expect.poll(() => viewer!.status).toBe("suspended");
      const port = Number(new URL(server.url).port);
      await server.close();
      server = await startServer({
        directory: root,
        ownerSecret: serverCredential.repeat(64),
        port,
      });
      viewer.setActive(true);
      await expect
        .poll(() => viewer!.status)
        .toBe(serverCredential === "b" ? "live" : "error");
      if (serverCredential === "b") expect(viewer.error).toBe("");
      else expect(viewer.error).not.toBe("");
      expect(viewer.received).toBe(prefix);
      expect(viewer.follow).toBe(false);
      await viewer.close();
      viewer = await BrowserSession.open(
        id,
        serverCredential.repeat(64),
        new AbortController().signal,
        () => {},
        server.url,
      );
      await expect.poll(() => viewer!.status).toBe("live");
      expect(viewer.received).toBe(prefix);
      viewer.setActive(false);
      await expect.poll(() => viewer!.status).toBe("suspended");
      await viewer.close();
      expect(viewer.status).toBe("stopped");
      viewer.setActive(true);
      viewer.reconnect();
      expect(viewer.status).toBe("stopped");
    } finally {
      await viewer?.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("excludes hidden time and removes lifecycle listeners when the viewer leaves", () => {
  class Page extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
  }
  const page = new Page(),
    windowEvents = new EventTarget();
  const session = { setActive: vi.fn(), reconnect: vi.fn() };
  let now = 0;
  const clock = new ForegroundClock(() => now);
  const unbind = bindPageLifecycle(session, page, windowEvents, clock);
  now = 100;
  expect(clock.elapsed()).toBe(100);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(session.setActive).toHaveBeenLastCalledWith(false);
  now += 8 * 60 * 60 * 1000;
  expect(clock.elapsed()).toBe(0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(session.setActive).toHaveBeenLastCalledWith(true);
  expect(session.reconnect).toHaveBeenCalledTimes(1);
  now += 25;
  expect(clock.elapsed()).toBe(25);
  windowEvents.dispatchEvent(new Event("pagehide"));
  now += 100000;
  expect(clock.elapsed()).toBe(0);
  windowEvents.dispatchEvent(new Event("online"));
  expect(session.setActive).toHaveBeenLastCalledWith(false);
  windowEvents.dispatchEvent(new Event("pageshow"));
  now += 10;
  expect(clock.elapsed()).toBe(10);
  windowEvents.dispatchEvent(new Event("focus"));
  expect(session.reconnect).toHaveBeenCalledTimes(3);
  unbind();
  const calls = session.setActive.mock.calls.length;
  for (const name of ["pagehide", "pageshow", "online", "focus"])
    windowEvents.dispatchEvent(new Event(name));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(session.setActive).toHaveBeenCalledTimes(calls);
  expect(session.reconnect).toHaveBeenCalledTimes(3);
});

it("treats an unobserved long foreground tick gap as suspension without jumping playback", () => {
  let now = 0;
  const clock = new ForegroundClock(() => now);
  now += 50;
  expect(clock.elapsed()).toBe(50);
  now += 8 * 60 * 60 * 1000;
  expect(clock.elapsed()).toBe(0);
  expect(clock.interrupted).toBe(true);
  now += 50;
  expect(clock.elapsed()).toBe(50);
  expect(clock.interrupted).toBe(false);
  now += 100000;
  clock.reset(); // Explicit play/speed changes establish a new anchor.
  expect(clock.elapsed()).toBe(0);
  expect(clock.interrupted).toBe(false);
});
