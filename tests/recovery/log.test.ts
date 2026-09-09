import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlLog, atomicJson } from "../../packages/storage/src/index.js";
const directories: string[] = [];
async function location() {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-log-test-"));
  directories.push(directory);
  return join(directory, "events.jsonl");
}
const parse = (input: unknown): { text: string } => {
  if (
    !input ||
    typeof input !== "object" ||
    !("text" in input) ||
    typeof input.text !== "string"
  )
    throw new TypeError("Invalid test event");
  return { text: input.text };
};
const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("durable JSONL log", () => {
  it("serializes concurrent batches and recovers checksummed records at the same boundary", async () => {
    const path = await location();
    let log = await JsonlLog.open(path, { parse, indexStride: 3 });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.append([{ text: `event ${i}: 雨🌧️` }]),
      ),
    );
    const boundary = log.boundary;
    await log.close();
    log = await JsonlLog.open(path, { parse, indexStride: 3 });
    expect(log.boundary).toEqual(boundary);
    const suffix = await collect(log.read(7, 13));
    expect(suffix.map((x) => x.sequence)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(suffix[0]?.value.text).toBe("event 7: 雨🌧️");
    await log.close();
  });
  it("discards only a torn trailing line and preserves the acknowledged prefix", async () => {
    const path = await location();
    let log = await JsonlLog.open(path, { parse });
    await log.append([{ text: "durable" }]);
    const boundary = log.boundary;
    await log.close();
    await appendFile(path, '{"sequence":2,"value":{"text":"incomplete');
    log = await JsonlLog.open(path, { parse });
    expect(log.boundary).toEqual(boundary);
    expect((await readFile(path)).length).toBe(boundary.byteOffset);
    await log.append([{ text: "retry" }]);
    expect((await collect(log.read())).map((x) => x.value.text)).toEqual([
      "durable",
      "retry",
    ]);
    await log.close();
  });
  it("quarantines complete corrupt lines instead of truncating evidence", async () => {
    const path = await location();
    const log = await JsonlLog.open(path, { parse });
    await log.append([{ text: "original" }]);
    await log.close();
    const corrupted = (await readFile(path, "utf8")).replace(
      "original",
      "tampered",
    );
    await writeFile(path, corrupted);
    await expect(JsonlLog.open(path, { parse })).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    expect(await readFile(path, "utf8")).toBe(corrupted);
  });
  it("never includes events beyond a frozen history boundary", async () => {
    const path = await location();
    const log = await JsonlLog.open(path, { parse });
    await log.append([{ text: "first" }]);
    const highWater = log.boundary.sequence;
    await log.append([{ text: "later" }]);
    expect(
      (await collect(log.read(0, highWater))).map((x) => x.value.text),
    ).toEqual(["first"]);
    await log.close();
  });
  it("rejects an oversized batch before any bytes are appended and remains writable", async () => {
    const path = await location();
    const log = await JsonlLog.open(path, { parse, maxRecordBytes: 300 });
    await expect(log.append([{ text: "x".repeat(500) }])).rejects.toThrow(
      "limit",
    );
    expect(log.boundary.sequence).toBe(0);
    await log.append([{ text: "valid" }]);
    await log.close();
  });
  it("freezes caller input before enqueueing", async () => {
    const path = await location();
    const log = await JsonlLog.open(path, { parse });
    const value = { text: "original" };
    const appended = log.append([value]);
    value.text = "mutated";
    await appended;
    expect((await collect(log.read()))[0]?.value.text).toBe("original");
    await log.close();
  });
  it("rejects future and fractional cursors", async () => {
    const log = await JsonlLog.open(await location(), { parse });
    await expect(collect(log.read(0, 1))).rejects.toMatchObject({
      code: "cursor_invalid",
    });
    await expect(collect(log.read(0.5, 0.5))).rejects.toMatchObject({
      code: "cursor_invalid",
    });
    await log.close();
  });
  it("atomically replaces JSON checkpoints and rejects lossy values", async () => {
    const path = await location();
    await atomicJson(path, { cursor: 1 });
    await atomicJson(path, { cursor: 2 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ cursor: 2 });
    await expect(atomicJson(path, { cursor: undefined })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ cursor: 2 });
  });
});
