import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextStore } from "../../packages/storage/src/index.js";
const signal = () => AbortSignal.timeout(10000);
it("imports only needed immutable pages, reopens offline and writes without querying the remote store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-disk-import-"));
  const remote = await TextStore.open(join(directory, "remote"));
  let calls = 0,
    bytes = 0;
  let local = await TextStore.open(
    join(directory, "local"),
    undefined,
    async (ref, active) => {
      calls++;
      const result = await remote.readBlob(ref, active);
      bytes += result.length;
      return result;
    },
  );
  try {
    const text = "prefix" + "x".repeat(131072) + "🦊";
    const ref = await remote.put(text);
    expect(await local.read(ref, 0, 6, signal())).toBe("prefix");
    expect(calls).toBe(2);
    expect(bytes).toBeLessThan(text.length / 2);
    await local.put("local-only", signal());
    expect(calls).toBe(2);
    const appended = await local.append(ref, " suffix", signal());
    expect(appended).toEqual(await remote.put(text + " suffix"));
    const before = calls;
    expect(await local.read(appended, appended.units - 9, 9, signal())).toBe(
      "🦊 suffix",
    );
    expect(calls).toBe(before);
    await local.close();
    local = await TextStore.open(join(directory, "local"));
    expect(await local.read(ref, 0, 6, signal())).toBe("prefix");
    expect(await local.read(appended, appended.units - 9, 9, signal())).toBe(
      "🦊 suffix",
    );
    await expect(local.read(ref, 70000, 1, signal())).rejects.toMatchObject({
      code: "precondition_failed",
    });
  } finally {
    await local.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects corrupt remote or local bytes, respects quota and never repairs corruption by downloading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-disk-integrity-"));
  const remote = await TextStore.open(join(directory, "remote"));
  let calls = 0;
  const ref = await remote.put("verified");
  let local = await TextStore.open(
    join(directory, "local"),
    undefined,
    async () => {
      calls++;
      return new Uint8Array(ref.byteSize);
    },
  );
  try {
    await expect(local.read(ref, 0, ref.units, signal())).rejects.toMatchObject(
      { code: "corrupt_storage" },
    );
    expect(local.usage.storedBytes).toBe(0);
    await local.close();
    local = await TextStore.open(
      join(directory, "local"),
      1,
      (reference, active) => remote.readBlob(reference, active),
    );
    await expect(local.read(ref, 0, ref.units, signal())).rejects.toThrow();
    expect(local.usage.storedBytes).toBe(0);
    await local.close();
    local = await TextStore.open(
      join(directory, "local"),
      undefined,
      async (reference, active) => {
        calls++;
        return remote.readBlob(reference, active);
      },
    );
    expect(await local.read(ref, 0, ref.units, signal())).toBe("verified");
    const before = calls;
    await writeFile(
      join(directory, "local", "pages", ref.hash),
      Buffer.alloc(ref.byteSize),
    );
    await expect(local.read(ref, 0, ref.units, signal())).rejects.toMatchObject(
      { code: "corrupt_storage" },
    );
    expect(calls).toBe(before);
  } finally {
    await local.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("releases ownership during a stalled loader and rejects its late result without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-disk-cancel-"));
  const remote = await TextStore.open(join(directory, "remote"));
  const ref = await remote.put("late");
  const downloaded = await remote.readBlob(ref);
  let entered!: () => void, complete!: (bytes: Uint8Array) => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const local = await TextStore.open(
    join(directory, "local"),
    undefined,
    async () => {
      entered();
      return new Promise<Uint8Array>((resolve) => {
        complete = resolve;
      });
    },
  );
  try {
    const failed = expect(
      local.read(ref, 0, ref.units, signal()),
    ).rejects.toThrow("closing");
    await ready;
    await local.close();
    await failed;
    const reopened = await TextStore.open(join(directory, "local"));
    try {
      complete(downloaded);
      await new Promise((resolve) => setImmediate(resolve));
      expect(await readdir(join(directory, "local", "pages"))).toEqual([
        ".uploads",
      ]);
      await expect(
        reopened.read(ref, 0, ref.units, signal()),
      ).rejects.toMatchObject({ code: "precondition_failed" });
    } finally {
      await reopened.close();
    }
  } finally {
    await local.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
