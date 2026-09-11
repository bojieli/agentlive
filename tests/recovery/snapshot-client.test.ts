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
it("verifies transferred codec bytes and rejects valid-length corrupt responses", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("{}");
  const ref = {
    hash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    units: 0,
  };
  for (const base64 of [bytes.toString("base64"), "AAAA", "!!!!", ""]) {
    const client = new RecordingSnapshotClient({
      ...options,
      fetch: async (url, init) => {
        expect(String(url)).toContain("/snapshot-blobs/");
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("error");
        return Response.json({ base64 });
      },
    });
    try {
      if (base64 === bytes.toString("base64"))
        expect(await client.readBlob(ref, AbortSignal.timeout(5000))).toEqual(
          new Uint8Array(bytes),
        );
      else
        await expect(
          client.readBlob(ref, AbortSignal.timeout(5000)),
        ).rejects.toMatchObject({ code: "corrupt_storage" });
    } finally {
      client.close();
    }
  }
});

it("rejects a snapshot past the requested time before loading its content", async () => {
  let calls = 0;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async (url) => {
      calls++;
      expect(new URL(String(url)).searchParams.get("timelineMs")).toBe("0.5");
      return Response.json({
        ...envelope,
        snapshot: { ...descriptor, timelineMs: 1 },
      });
    },
  });
  try {
    await expect(
      client.select(1, AbortSignal.timeout(2000), 0.5),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    expect(calls).toBe(1);
  } finally {
    client.close();
  }
});
const leaseFixture = {
  token: "c".repeat(64),
  expiresAt: 1000,
  snapshot: {
    ...descriptor,
    format: "agentlive.paged-state" as const,
    activity: { ...descriptor.ref, hash: "b".repeat(64) },
  },
};
const leaseEnvelope = {
  streamId: options.streamId,
  revision: options.revision,
  lease: leaseFixture,
};
it("acquires immutable lease provenance and validates renewal identity, roots and expiry", async () => {
  let reply: unknown = leaseEnvelope;
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(reply);
    },
  });
  const signal = AbortSignal.timeout(5000);
  try {
    const lease = (await client.acquireLease(1, signal, 0))!;
    expect(Object.isFrozen(lease.snapshot.ref)).toBe(true);
    expect(Object.isFrozen(lease.snapshot.activity)).toBe(true);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({
      revision: options.revision,
      throughServerSeq: 1,
      timelineMs: 0,
    });
    reply = { ...leaseEnvelope, lease: { ...leaseFixture, expiresAt: 2000 } };
    expect((await client.renewLease(lease, signal)).expiresAt).toBe(2000);
    for (const changed of [
      null,
      { ...leaseFixture, token: "d".repeat(64) },
      { ...leaseFixture, expiresAt: 999 },
      {
        ...leaseFixture,
        snapshot: { ...leaseFixture.snapshot, activity: { ...descriptor.ref } },
      },
    ]) {
      reply = { ...leaseEnvelope, lease: changed };
      await expect(client.renewLease(lease, signal)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await client.releaseLease(lease, signal);
    expect(requests.at(-1)!.url).toContain(
      `/snapshot-leases/${lease.token}?revision=revision`,
    );
    expect(
      new Headers(requests.at(-1)!.init!.headers).get("authorization"),
    ).toBe(`Bearer ${options.credential}`);
  } finally {
    client.close();
  }
});
it("rejects wrong lease binding and selection boundaries and propagates stale renewal", async () => {
  for (const [reply, code] of [
    [{ ...leaseEnvelope, revision: "other" }, "revision_changed"],
    [
      {
        ...leaseEnvelope,
        lease: {
          ...leaseFixture,
          snapshot: { ...leaseFixture.snapshot, serverSeq: 2 },
        },
      },
      "sequence_gap",
    ],
    [
      {
        ...leaseEnvelope,
        lease: {
          ...leaseFixture,
          snapshot: { ...leaseFixture.snapshot, timelineMs: 1 },
        },
      },
      "sequence_gap",
    ],
    [
      { ...leaseEnvelope, lease: { ...leaseFixture, snapshot: descriptor } },
      "invalid_request",
    ],
  ] as const) {
    const client = new RecordingSnapshotClient({
      ...options,
      fetch: async () => Response.json(reply),
    });
    try {
      await expect(
        client.acquireLease(1, AbortSignal.timeout(2000), 0),
      ).rejects.toMatchObject({ code });
    } finally {
      client.close();
    }
  }
  let calls = 0;
  const client = new RecordingSnapshotClient({
    ...options,
    fetch: async () => {
      calls++;
      return Response.json(
        { error: { code: "stale_lease", message: "expired" } },
        { status: 409 },
      );
    },
  });
  await expect(
    client.renewLease(leaseFixture, AbortSignal.timeout(2000)),
  ).rejects.toMatchObject({ code: "stale_lease" });
  client.close();
  await expect(
    client.acquireLease(1, AbortSignal.timeout(2000)),
  ).rejects.toThrow("closed");
  expect(calls).toBe(1);
});
