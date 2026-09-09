import { expect, it } from "vitest";
import { openRecordingHistory } from "../../packages/client/src/index.js";
const event = (serverSeq: number) => ({
  protocolVersion: 1,
  serverSeq,
  receivedAt: "2026-09-01T00:00:00.000Z",
  timelineMs: serverSeq,
  content: { kind: "recording.created", payload: { title: "Test" } },
  origin: { type: "server", operationId: `record_${serverSeq}` },
});
const page = (events: ReturnType<typeof event>[]) =>
  new Response(events.map((value) => JSON.stringify(value)).join("\n") + "\n", {
    headers: {
      "x-agentlive-revision": "revision",
      "x-agentlive-through": "2",
      "x-agentlive-next-cursor": "2",
      "x-agentlive-complete": "true",
    },
  });
it("rejects a malformed page before yielding its valid prefix", async () => {
  const fetcher: typeof fetch = async (url) =>
    String(url).includes("/events?")
      ? page([event(1), event(3)])
      : Response.json({
          revision: "revision",
          serverSeq: 2,
          title: "Test",
          lifecycle: "ended",
        });
  const history = await openRecordingHistory({
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    signal: AbortSignal.timeout(5000),
    fetch: fetcher,
  });
  await expect(history.events.next()).rejects.toThrow("not contiguous");
});
it("retries a lost page response and isolates the fixed boundary from metadata mutation", async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).includes("/events?"))
      return Response.json({
        revision: "revision",
        serverSeq: 2,
        title: "Test",
        lifecycle: "ended",
      });
    expect(new URL(String(url)).searchParams.get("throughServerSeq")).toBe("2");
    if (attempts++ === 0) throw new TypeError("connection interrupted");
    return page([event(1), event(2)]);
  };
  const history = await openRecordingHistory({
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    signal: AbortSignal.timeout(5000),
    fetch: fetcher,
  });
  history.metadata.serverSeq = 999;
  const events = [];
  for await (const event of history.events) events.push(event);
  expect(events.map((event) => event.serverSeq)).toEqual([1, 2]);
  expect(attempts).toBe(2);
});
it("downloads a fixed suffix without replaying the preceding prefix", async () => {
  const urls: string[] = [];
  const history = await openRecordingHistory({
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    signal: AbortSignal.timeout(5000),
    fetch: async (url) => {
      urls.push(String(url));
      if (!String(url).includes("/events?"))
        return Response.json({
          revision: "revision",
          serverSeq: 2,
          title: "Test",
          lifecycle: "ended",
        });
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("afterServerSeq")).toBe("1");
      expect(parsed.searchParams.get("throughServerSeq")).toBe("2");
      return page([event(2)]);
    },
  });
  expect(
    (
      await Array.fromAsync(
        history.range({ afterServerSeq: 1, throughServerSeq: 2 }),
      )
    ).map((item) => item.serverSeq),
  ).toEqual([2]);
  expect(await Array.fromAsync(history.range({ afterServerSeq: 2 }))).toEqual(
    [],
  );
  await expect(history.range({ throughServerSeq: 3 }).next()).rejects.toThrow(
    "captured boundary",
  );
  expect(urls).toHaveLength(2);
});
