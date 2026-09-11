import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalLeaseCatalog } from "../../packages/cli/src/watch-leases.js";
const binding = {
  serverOrigin: "https://example.test",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(5000);
const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
const lease = {
  token: "b".repeat(64),
  expiresAt: 100,
  snapshot: {
    format: "agentlive.paged-state" as const,
    serverSeq: 1,
    timelineMs: 0,
    ref,
    activity: ref,
  },
};
it("durably copies lease provenance and fences stale renewal and release across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-watch-leases-"));
  const cache = { contentDirectory: directory, binding };
  let catalog = new TerminalLeaseCatalog(cache);
  try {
    const input = structuredClone(lease);
    const saved = catalog.save(null, input, signal());
    input.snapshot.ref.hash = "c".repeat(64);
    await saved;
    await catalog.close();
    catalog = new TerminalLeaseCatalog(cache);
    expect(await catalog.load(signal())).toEqual([lease]);
    const next = { ...lease, expiresAt: 200 };
    await catalog.save(lease, next, signal());
    await expect(catalog.save(lease, null, signal())).rejects.toMatchObject({
      code: "event_conflict",
    });
    await expect(
      catalog.save(next, null, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect(await catalog.load(signal())).toEqual([next]);
    await catalog.save(next, null, signal());
    await expect(
      catalog.save(next, { ...next, expiresAt: 300 }, signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await catalog.close();
    await expect(catalog.load(signal())).rejects.toThrow("closing");
  } finally {
    await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects malformed, duplicate and wrong-revision catalogs without treating roots as absent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentlive-watch-bad-leases-"),
  );
  const catalog = new TerminalLeaseCatalog({
    contentDirectory: directory,
    binding,
  });
  try {
    for (const raw of [
      "broken",
      JSON.stringify({ version: 1, binding, leases: [lease, lease] }),
      JSON.stringify({
        version: 1,
        binding: { ...binding, revision: "other" },
        leases: [lease],
      }),
    ]) {
      await writeFile(join(directory, "leases.json"), raw);
      await expect(catalog.load(signal())).rejects.toMatchObject({
        code: "corrupt_storage",
      });
    }
  } finally {
    await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves roots at capacity and drains an admitted publication before close", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentlive-watch-full-leases-"),
  );
  const catalog = new TerminalLeaseCatalog({
    contentDirectory: directory,
    binding,
  });
  try {
    const leases = Array.from({ length: 128 }, (_, n) => ({
      ...lease,
      token: n.toString(16).padStart(64, "0"),
    }));
    await writeFile(
      join(directory, "leases.json"),
      JSON.stringify({ version: 1, binding, leases }),
    );
    await expect(catalog.save(null, lease, signal())).rejects.toMatchObject({
      code: "retry_later",
    });
    expect(await catalog.load(signal())).toEqual(leases);
    const update = catalog.save(
      leases[0]!,
      { ...leases[0]!, expiresAt: 200 },
      signal(),
    );
    await catalog.close();
    await update;
    const reopened = new TerminalLeaseCatalog({
      contentDirectory: directory,
      binding,
    });
    try {
      const saved = await reopened.load(signal());
      expect(saved).toHaveLength(128);
      expect(
        saved.find((item) => item.token === leases[0]!.token)!.expiresAt,
      ).toBe(200);
    } finally {
      await reopened.close();
    }
  } finally {
    await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("clears the import union atomically and rejects stale or cancelled cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-watch-clear-"));
  const cache = { contentDirectory: directory, binding };
  let catalog = new TerminalLeaseCatalog(cache);
  try {
    const second = { ...lease, token: "c".repeat(64) };
    await catalog.save(null, lease, signal());
    await catalog.save(null, second, signal());
    const before = await catalog.load(signal());
    await expect(
      catalog.clear(before, AbortSignal.abort(new Error("cancel cleanup"))),
    ).rejects.toThrow("cancel cleanup");
    expect(await catalog.load(signal())).toEqual(before);
    const renewed = { ...second, expiresAt: 200 };
    await catalog.save(second, renewed, signal());
    await expect(catalog.clear(before, signal())).rejects.toMatchObject({
      code: "event_conflict",
    });
    const current = await catalog.load(signal());
    expect(current).toEqual([lease, renewed]);
    const clearing = catalog.clear(current, signal());
    current.length = 0;
    await clearing;
    await catalog.close();
    catalog = new TerminalLeaseCatalog(cache);
    expect(await catalog.load(signal())).toEqual([]);
    await expect(
      catalog.save(renewed, { ...renewed, expiresAt: 300 }, signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
  } finally {
    await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
