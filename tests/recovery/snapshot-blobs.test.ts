import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
it("fetches only selected codec blobs, reopens them locally, and appends with identical content identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-blob-transfer-"));
  const remote = await TextStore.open(directory);
  const factory = new IDBFactory();
  let downloaded = 0,
    calls = 0;
  const loader = async (ref: any, active: AbortSignal) => {
    const bytes = await remote.readBlob(ref, active);
    downloaded += bytes.length;
    calls++;
    return bytes;
  };
  let local = await BrowserContentStore.open(
    factory,
    binding,
    signal(),
    undefined,
    loader,
  );
  try {
    const text = "prefix" + "x".repeat(131072) + "🦊";
    const ref = await remote.put(text);
    expect(await local.read(ref, 0, 6, signal())).toBe("prefix");
    expect(calls).toBe(2);
    expect(downloaded).toBeLessThan(text.length / 2);
    await local.close();
    local = await BrowserContentStore.open(factory, binding, signal());
    expect(await local.read(ref, 0, 6, signal())).toBe("prefix");
    await expect(
      local.read(ref, ref.units - 2, 2, signal()),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    await local.close();
    local = await BrowserContentStore.open(
      factory,
      binding,
      signal(),
      undefined,
      loader,
    );
    const appended = await local.append(ref, " suffix", signal());
    expect(appended).toEqual(await remote.put(text + " suffix"));
    expect(await local.read(appended, appended.units - 9, 9, signal())).toBe(
      "🦊 suffix",
    );
    expect(await local.read(ref, ref.units - 2, 2, signal())).toBe("🦊");
  } finally {
    await local.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects corrupt remote bytes and does not let a stalled loader hold browser ownership", async () => {
  const factory = new IDBFactory();
  const ref = { hash: "a".repeat(64), byteSize: 2, units: 1 };
  const bad = await BrowserContentStore.open(
    factory,
    binding,
    signal(),
    undefined,
    async () => new Uint8Array([123, 125]),
  );
  await expect(bad.read(ref, 0, 1, signal())).rejects.toMatchObject({
    code: "corrupt_storage",
  });
  await bad.close();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stalled = await BrowserContentStore.open(
    factory,
    binding,
    signal(),
    undefined,
    async () => {
      entered();
      return new Promise<Uint8Array>(() => {});
    },
  );
  const rejected = expect(stalled.read(ref, 0, 1, signal())).rejects.toThrow(
    "closing",
  );
  await ready;
  await stalled.close();
  await rejected;
});
