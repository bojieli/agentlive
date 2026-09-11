import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewingGrants } from "../../packages/server/src/viewing-grants.js";
it("persists only token hashes, enforces scope/expiry and durably revokes after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-grants-"));
  const path = join(root, "viewing-grants.json");
  let store = await ViewingGrants.open(path);
  try {
    await expect(ViewingGrants.open(path)).rejects.toMatchObject({
      code: "publisher_busy",
    });
    const grant = await store.issue({
      streamId: "one",
      revision: "rev1",
      label: "Demo viewer",
      expiresAt: Date.now() + 60000,
    });
    expect(store.authorize(grant.token, "one", "rev1")?.id).toBe(grant.id);
    expect(store.authorize(grant.token, "two", "rev1")).toBeUndefined();
    expect(store.authorize(grant.token, "one", "restored")).toBeUndefined();
    expect(store.authorize("wrong", "one", "rev1")).toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain(grant.token);
    expect(JSON.stringify(store.list("one"))).not.toContain("tokenHash");
    await store.close();
    store = await ViewingGrants.open(path);
    expect(store.authorize(grant.token, "one", "rev1")?.id).toBe(grant.id);
    const notify = vi.fn();
    store.onRevoke(notify);
    expect(await store.revoke("two", grant.id)).toBe(false);
    const active = store.acquire(grant.token, "one", "rev1");
    await rename(path, path + ".saved");
    await mkdir(path);
    await expect(store.revoke("one", grant.id)).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
    expect(active.signal.aborted).toBe(false);
    expect(store.authorize(grant.token, "one", "rev1")?.id).toBe(grant.id);
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    expect(await store.revoke("one", grant.id)).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(grant.id);
    expect(active.signal.aborted).toBe(true);
    active.close();
    expect(store.authorize(grant.token, "one", "rev1")).toBeUndefined();
    expect(await store.revoke("one", grant.id)).toBe(false);
    const expires = await store.issue({
      streamId: "one",
      revision: "rev1",
      label: "Expires",
      expiresAt: Date.now() + 1000,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(expires.expiresAt);
    try {
      expect(store.authorize(expires.token, "one", "rev1")).toBeUndefined();
      expect(store.list("one")).toEqual([]);
    } finally {
      now.mockRestore();
    }
    await store.close();
    store = await ViewingGrants.open(path);
    expect(store.authorize(grant.token, "one", "rev1")).toBeUndefined();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects malformed persisted grants and bounds expiry and active grant admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-grant-limits-"));
  const path = join(root, "grants.json");
  const store = await ViewingGrants.open(path);
  try {
    const input = {
      streamId: "one",
      revision: "rev",
      label: "viewer",
      expiresAt: Date.now() + 60000,
    };
    await expect(
      store.issue({ ...input, expiresAt: Date.now() - 1 }),
    ).rejects.toThrow("expiry");
    await expect(
      store.issue({ ...input, expiresAt: Date.now() + 367 * 86400000 }),
    ).rejects.toThrow("expiry");
    for (let index = 0; index < 128; index++) await store.issue(input);
    await expect(store.issue(input)).rejects.toMatchObject({
      code: "retry_later",
    });
    await store.issue({ ...input, streamId: "two" });
    await store.close();
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.grants.push(saved.grants[0]);
    await writeFile(path, JSON.stringify(saved));
    await expect(ViewingGrants.open(path)).rejects.toThrow("duplicate");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates active readers on durable revocation, expiry, cancellation and shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-grant-lifetime-"));
  const store = await ViewingGrants.open(join(root, "grants.json"));
  try {
    const input = {
      streamId: "one",
      revision: "rev",
      label: "viewer",
      expiresAt: Date.now() + 60000,
    };
    const grant = await store.issue(input);
    const other = await store.issue(input);
    const first = store.acquire(grant.token, "one", "rev");
    const second = store.acquire(grant.token, "one", "rev");
    const unrelated = store.acquire(other.token, "one", "rev");
    expect(() => store.acquire(grant.token, "wrong", "rev")).toThrow("invalid");
    const pending = store.revoke("one", grant.id);
    expect(first.signal.aborted).toBe(false);
    await pending;
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    expect(() => store.acquire(grant.token, "one", "rev")).toThrow("invalid");
    const parent = new AbortController();
    const cancelled = store.acquire(other.token, "one", "rev", parent.signal);
    parent.abort(new Error("client disconnected"));
    expect(cancelled.signal.reason.message).toBe("client disconnected");
    cancelled.close();
    cancelled.close();
    const expiring = await store.issue({
      ...input,
      expiresAt: Date.now() + 5000,
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const lifetime = store.acquire(expiring.token, "one", "rev");
      await vi.advanceTimersByTimeAsync(5001);
      expect(lifetime.signal.aborted).toBe(true);
      expect(lifetime.signal.reason.message).toContain("expired");
      lifetime.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await store.close();
    expect(unrelated.signal.aborted).toBe(true);
    unrelated.close();
    first.close();
    second.close();
  } finally {
    vi.useRealTimers();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("handles expiry beyond the platform timer maximum without expiring early", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-grant-long-expiry-"));
  const store = await ViewingGrants.open(join(root, "grants.json"));
  try {
    const expiresAt = Date.now() + 3000000000;
    const grant = await store.issue({
      streamId: "one",
      revision: "rev",
      label: "long",
      expiresAt,
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const active = store.acquire(grant.token, "one", "rev");
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(active.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(expiresAt - Date.now());
    expect(active.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
