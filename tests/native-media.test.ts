import { expect, it } from "vitest";
import { nativeMediaEvents } from "../packages/adapters/src/native-media.js";
it("represents unavailable media without publishing raw URLs or invoking a resolver for mismatched data", async () => {
  const base = {
    artifactId: "image",
    messageId: "message",
    sourceKey: "source",
    nativeAgent: "kimi",
    mediaKind: "image" as const,
  };
  let calls = 0;
  const resolvers = {
    resolveInline: async () => {
      calls++;
      throw new Error("Unexpected capture");
    },
  };
  for (const url of [
    "https://private.example/file?token=secret",
    "data:audio/aac;base64,AQID",
    "data:image/png;base64,invalid!",
  ]) {
    const events = await nativeMediaEvents({ ...base, url, resolvers });
    expect(events.map((event) => event.kind)).toEqual([
      "attachment.pending",
      "attachment.unavailable",
    ]);
    expect(JSON.stringify(events)).not.toContain(url);
  }
  expect(calls).toBe(0);
});
