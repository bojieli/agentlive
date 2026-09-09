import { expect, it } from "vitest";
import { RecordingSnapshotClient } from "../../packages/client/src/index.js";
const options = {
  serverOrigin: "https://example.test",
  streamId: "stream",
  revision: "revision",
  credential: "private-test-credential",
};
const descriptor = {
  serverSeq: 1,
  timelineMs: 0,
  ref: { hash: "a".repeat(64), byteSize: 12, units: 2 },
};
const envelope = {
  streamId: options.streamId,
  revision: options.revision,
  snapshot: descriptor,
};

it("rejects mismatched bindings and future boundaries before fetching content", async () => {
  for (const [raw, code] of [
    [{ ...envelope, streamId: "other" }, "revision_changed"],
    [{ ...envelope, revision: "other" }, "revision_changed"],
    [
      { ...envelope, snapshot: { ...descriptor, serverSeq: 2 } },
      "sequence_gap",
    ],
    [{ ...envelope, extra: true }, "invalid_request"],
  ] as const) {
    let requests = 0;
    const client = new RecordingSnapshotClient({
      ...options,
      fetch: async (_url, init) => {
        requests++;
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        expect(init?.cache).toBe("no-store");
        return Response.json(raw);
      },
    });
    try {
      await expect(
        client.select(1, AbortSignal.timeout(2000)),
      ).rejects.toMatchObject({ code });
      expect(requests).toBe(1);
    } finally {
      client.close();
    }
  }
});
it("rejects partial content and publication responses that omit the requested snapshot", async () => {
  let calls = 0;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async () => Response.json(calls++ === 0 ? envelope : { text: "{" }),
  });
  try {
    await expect(
      client.select(1, AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
  } finally {
    client.close();
  }
  const empty = new RecordingSnapshotClient({
    ...options,
    fetch: async () => Response.json({ ...envelope, snapshot: null }),
  });
  try {
    expect(await empty.select(1, AbortSignal.timeout(2000))).toBeNull();
    await expect(
      empty.publish(1, AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: "invalid_request" });
  } finally {
    empty.close();
  }
});
it("bounds an oversized response even when underlying cancellation never settles", async () => {
  let cancelled = false;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5000));
          },
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      ),
  });
  try {
    await expect(client.select(1, AbortSignal.timeout(2000))).rejects.toThrow(
      "exceeds limit",
    );
    expect(cancelled).toBe(true);
  } finally {
    client.close();
  }
});
it("closes a stalled content stream without awaiting uncooperative cancellation", async () => {
  let started!: () => void;
  const receiving = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0,
    cancelled = false;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async () => {
      if (calls++ === 0) return Response.json(envelope);
      return new Response(
        new ReadableStream({
          pull() {
            started();
          },
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      );
    },
  });
  const result = client.select(1, AbortSignal.timeout(2000));
  const rejected = expect(result).rejects.toThrow("closed");
  await receiving;
  client.close();
  await rejected;
  expect(cancelled).toBe(true);
  await expect(client.select(1, AbortSignal.timeout(2000))).rejects.toThrow(
    "closed",
  );
});
it("bounds concurrent requests and cancels all accepted work on close", async () => {
  let requests = 0;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async () => {
      requests++;
      return new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        }),
      );
    },
  });
  const work = Array.from({ length: 16 }, () =>
    client.select(1, AbortSignal.timeout(2000)),
  );
  const settled = Promise.allSettled(work);
  await expect(
    client.select(1, AbortSignal.timeout(2000)),
  ).rejects.toMatchObject({ code: "retry_later" });
  client.close();
  expect(requests).toBe(16);
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
});

it("scopes cached ranges to recording revisions and still authorizes each selection", async () => {
  const { initialPagedState } =
    await import("../../packages/playback/src/index.js");
  const rows = new Map<string, string>();
  let selections = 0,
    reads = 0;
  const cache = {
    read: async (key: string) => rows.get(key),
    write: async (key: string, text: string) => {
      rows.set(key, text);
    },
  };
  for (const revision of ["revision", "revision", "changedx"]) {
    const text = JSON.stringify({
      format: "agentlive.paged-state",
      version: 1,
      reducerVersion: 1,
      streamId: options.streamId,
      revision,
      state: initialPagedState(),
    });
    const ref = { hash: "a".repeat(64), byteSize: 12, units: text.length };
    const client = new RecordingSnapshotClient({
      ...options,
      revision,
      cache,
      fetch: async (url) => {
        if (new URL(String(url)).pathname.includes("snapshot-content")) {
          reads++;
          return Response.json({ text });
        }
        selections++;
        return Response.json({
          streamId: options.streamId,
          revision,
          snapshot: {
            format: "agentlive.paged-state",
            serverSeq: 0,
            timelineMs: 0,
            ref,
          },
        });
      },
    });
    try {
      expect(
        (await client.select(0, AbortSignal.timeout(2000)))!.reader.manifest
          .serverSeq,
      ).toBe(0);
    } finally {
      client.close();
    }
  }
  expect(selections).toBe(3);
  expect(reads).toBe(2);
  expect(rows.size).toBe(2);
});
it("cancels a stalled cache lookup without waiting for its implementation", async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = new RecordingSnapshotClient({
    ...options,
    cache: {
      read: async () => {
        started();
        return new Promise(() => {});
      },
      write: async () => {},
    },
    fetch: async () => Response.json(envelope),
  });
  const task = client.select(1, AbortSignal.timeout(2000));
  await waiting;
  client.close();
  await expect(task).rejects.toThrow("closed");
});
