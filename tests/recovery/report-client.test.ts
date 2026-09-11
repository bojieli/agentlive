import { expect, it } from "vitest";
import { submitReport } from "../../packages/client/src/reports.js";
it("preserves report identity across uncertain delivery and rejects invalid receipts", async () => {
  const bodies: string[] = [];
  const options = {
    serverOrigin: "https://example.com",
    streamId: "recording",
    credential: "",
    input: {
      operationId: "repeat-report",
      category: "privacy" as const,
      details: "  Please review  ",
    },
    signal: new AbortController().signal,
  };
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(
      "https://example.com/api/v1/streams/recording/reports",
    );
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new Error("lost response");
    return Response.json(
      { reportId: "receipt", receivedAt: 1 },
      { status: 201 },
    );
  };
  await expect(
    submitReport({ ...options, fetch: transport }),
  ).rejects.toThrow();
  expect(await submitReport({ ...options, fetch: transport })).toEqual({
    reportId: "receipt",
    receivedAt: 1,
  });
  expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0]!).details).toBe("Please review");
  await expect(
    submitReport({
      ...options,
      fetch: async () => Response.json({ reportId: "receipt", receivedAt: -1 }),
    }),
  ).rejects.toThrow();
  await expect(
    submitReport({
      ...options,
      input: { ...options.input, details: " " },
      fetch: transport,
    }),
  ).rejects.toThrow();
  expect(bodies).toHaveLength(2);
});
