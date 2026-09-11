import { it, expect } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentMarks } from "../../packages/storage/src/index.js";
const hash = (index: number) => index.toString(16).padStart(64, "0");
it("seals a disk-backed deduplicated mark set before allowing lookups and cleans up", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agentlive-marks-test-"));
  const marks = await ContentMarks.create(parent);
  try {
    expect(() => marks.has(hash(0))).toThrow("building");
    for (let i = 0; i < 10000; i++) {
      marks.add(hash(i));
      marks.add(hash(i));
    }
    expect((await readdir(parent)).length).toBe(1);
    await marks.seal();
    for (const i of [0, 1, 127, 9999]) expect(marks.has(hash(i))).toBe(true);
    expect(marks.has(hash(10000))).toBe(false);
    expect(() => marks.add(hash(10000))).toThrow("sealed");
    expect(marks.has(hash(0))).toBe(true);
    await expect(marks.seal()).rejects.toThrow("sealed");
    await marks.close();
    await marks.close();
    expect(await readdir(parent)).toEqual([]);
    expect(() => marks.has(hash(0))).toThrow("closed");
  } finally {
    await marks.close();
    await rm(parent, { recursive: true, force: true });
  }
});
it("poisons failed or cancelled mark builds so partial sets cannot authorize sweeping", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agentlive-marks-failure-"));
  try {
    for (const failure of ["invalid", "cancel-add", "cancel-seal"]) {
      const marks = await ContentMarks.create(parent);
      try {
        marks.add(hash(1));
        const abort = new AbortController();
        abort.abort(new Error("cancel marks"));
        if (failure === "invalid") expect(() => marks.add("bad")).toThrow();
        else if (failure === "cancel-add")
          expect(() => marks.add(hash(2), abort.signal)).toThrow(
            "cancel marks",
          );
        else
          await expect(marks.seal(abort.signal)).rejects.toThrow(
            "cancel marks",
          );
        expect(() => marks.has(hash(3))).toThrow("failed");
        await expect(marks.seal()).rejects.toThrow("failed");
      } finally {
        await marks.close();
      }
    }
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("memoizes complete trace descriptors only within one mark attempt and rejects conflicting metadata", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agentlive-traced-marks-"));
  const marks = await ContentMarks.create(parent);
  const ref = { hash: hash(1), byteSize: 20, units: 10 };
  try {
    expect(marks.traced(ref)).toBe(false);
    marks.add(ref.hash);
    expect(marks.traced(ref)).toBe(false);
    marks.recordTrace(ref);
    expect(marks.traced(ref)).toBe(true);
    marks.recordTrace(ref);
    expect(() => marks.traced({ ...ref, units: 11 })).toThrow("descriptor");
    await expect(marks.seal()).rejects.toThrow("failed");
  } finally {
    await marks.close();
  }
  const fresh = await ContentMarks.create(parent);
  try {
    expect(fresh.traced(ref)).toBe(false);
  } finally {
    await fresh.close();
    await rm(parent, { recursive: true, force: true });
  }
});
