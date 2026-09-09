import { expect, it } from "vitest";
import { observeOpenCodeSession } from "../../packages/adapters/src/index.js";
const info = { id: "ses_test", time: { created: 1 } };
const message = (text: string) => ({
  info: {
    id: "msg_test",
    sessionID: "ses_test",
    role: "assistant",
    time: { created: 1 },
  },
  parts: [
    {
      id: "prt_test",
      messageID: "msg_test",
      sessionID: "ses_test",
      type: "text",
      text,
    },
  ],
});
it("subscribes before backfill and reconciles updates occurring during commit or without notifications", async () => {
  const abort = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let text = "history";
  const seen: string[] = [];
  const order: string[] = [];
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    order.push(path);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:password").toString("base64")}`,
    );
    if (path === "/event")
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json(path.endsWith("/message") ? [message(text)] : info);
  }) as typeof fetch;
  await observeOpenCodeSession({
    serverOrigin: "http://localhost:9999",
    nativeSessionId: info.id,
    password: "password",
    signal: abort.signal,
    fetch: fetcher,
    pollMs: 5,
    commit: async (snapshot) => {
      const value = snapshot.messages[0]!.parts[0]!.text as string;
      seen.push(value);
      if (value === "history") {
        text = "during commit 海";
        const bytes = new TextEncoder().encode(
          'data: {"type":"message.updated",\r\ndata: "properties":{"text":"海"}}\r\n\r\n',
        );
        for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else if (value === "during commit 海") text = "missed notification";
      else abort.abort();
    },
  });
  expect(order[0]).toBe("/event");
  expect(seen).toEqual(["history", "during commit 海", "missed notification"]);
});
it("resubscribes and refetches history after SSE disconnect", async () => {
  const abort = new AbortController();
  let subscriptions = 0;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let commits = 0;
  const fetcher = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/event") {
      subscriptions++;
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json(
      path.endsWith("/message") ? [message(String(subscriptions))] : info,
    );
  }) as typeof fetch;
  await observeOpenCodeSession({
    serverOrigin: "http://localhost",
    nativeSessionId: info.id,
    signal: abort.signal,
    fetch: fetcher,
    retryMs: 1,
    commit: async () => {
      if (++commits === 1) stream.close();
      else abort.abort();
    },
  });
  expect(commits).toBe(2);
  expect(subscriptions).toBe(2);
});
it("does not retry capture failures and rejects foreign snapshot identities", async () => {
  for (const foreign of [false, true]) {
    let commits = 0;
    let subscriptions = 0;
    const fetcher = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/event") {
        subscriptions++;
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(
        path.endsWith("/message")
          ? [message("history")]
          : { ...info, id: foreign ? "ses_other" : info.id },
      );
    }) as typeof fetch;
    await expect(
      observeOpenCodeSession({
        serverOrigin: "http://localhost",
        nativeSessionId: info.id,
        signal: AbortSignal.timeout(5000),
        fetch: fetcher,
        commit: async () => {
          commits++;
          throw new TypeError("Disk capture failed");
        },
      }),
    ).rejects.toThrow(
      foreign ? "conflicting message identities" : "snapshot capture failed",
    );
    expect(commits).toBe(foreign ? 0 : 1);
    expect(subscriptions).toBe(1);
  }
});
it("bounds incomplete SSE frames and treats invalid UTF-8 as a terminal protocol error", async () => {
  for (const [bytes, expected] of [
    [new Uint8Array([0xff]), "invalid UTF-8"],
    [
      new TextEncoder().encode("data:" + "x".repeat(2 * 1024 * 1024)),
      "exceeds limit",
    ],
  ] as const) {
    let subscriptions = 0;
    const fetcher = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/event") {
        subscriptions++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(path.endsWith("/message") ? [] : info);
    }) as typeof fetch;
    await expect(
      observeOpenCodeSession({
        serverOrigin: "http://localhost",
        nativeSessionId: info.id,
        signal: AbortSignal.timeout(5000),
        fetch: fetcher,
        commit: async () => {},
      }),
    ).rejects.toThrow(expected);
    expect(subscriptions).toBe(1);
  }
});
