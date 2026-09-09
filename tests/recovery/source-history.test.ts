import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonlSource } from "../../packages/adapters/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function source(text: string) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-source-test-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, text);
  return path;
}
async function read(
  path: string,
  options: Parameters<typeof readJsonlSource>[1] = {},
) {
  const records = [];
  for await (const record of readJsonlSource(path, options))
    records.push(record);
  return records;
}
it("freezes history before concurrent appends and resumes the suffix by validated cursor", async () => {
  const path = await source('{"n":1}\n{"n":2}\n');
  const iterator = readJsonlSource(path);
  const first = await iterator.next();
  await appendFile(path, '{"n":3}\n');
  const second = await iterator.next();
  expect((await iterator.next()).done).toBe(true);
  expect(second.value!.value).toEqual({ n: 2 });
  const rest = await read(path, { after: second.value!.cursor });
  expect(rest.map((x) => x.value)).toEqual([{ n: 3 }]);
  expect(first.value!.cursor.offset).toBe(8);
});
it("defers partial live records and includes a valid final line for closed-file import", async () => {
  const path = await source('{"n":1}\n{"n":');
  const first = await read(path);
  expect(first).toHaveLength(1);
  await appendFile(path, "2}");
  expect(await read(path, { after: first[0]!.cursor })).toHaveLength(0);
  expect(
    (await read(path, { after: first[0]!.cursor, tail: "parse" })).map(
      (x) => x.value,
    ),
  ).toEqual([{ n: 2 }]);
});
it("rejects rewritten prefixes and malformed complete lines", async () => {
  const path = await source('{"n":1}\n');
  const first = await read(path);
  await writeFile(path, '{"n":2}\n{"n":3}\n');
  await expect(read(path, { after: first[0]!.cursor })).rejects.toThrow(
    "prefix changed",
  );
  await writeFile(path, "{broken}\n");
  await expect(read(path)).rejects.toThrow();
});
it("parses large UTF-8 records across read chunks and bounds record allocation", async () => {
  const text = "海🦦".repeat(20000);
  const path = await source(JSON.stringify({ text }) + '\n{"last":true}\n');
  const values = await read(path);
  expect(values[0]!.value).toEqual({ text });
  expect((await read(path, { after: values[0]!.cursor }))[0]!.value).toEqual({
    last: true,
  });
  await expect(read(path, { maxRecordBytes: 100 })).rejects.toThrow(
    "exceeds limit",
  );
});
it("backfills before the live boundary, finishes partial records and resumes from durable consumer receipt", async () => {
  const { followJsonlSource } =
    await import("../../packages/adapters/src/index.js");
  const path = await source('{"n":1}\n{"n":2}\n{"n":');
  const controller = new AbortController();
  const values: unknown[] = [];
  let cursor:
    import("../../packages/adapters/src/index.js").SourceCursor | undefined;
  const running = followJsonlSource(path, {
    signal: controller.signal,
    pollMs: 1,
    commit: async (record) => {
      values.push(record.value);
      cursor = record.cursor;
      if (values.length === 1) await appendFile(path, "3}\n");
      if (values.length === 3) controller.abort();
    },
    onCaughtUp: async (boundary) => {
      expect(values).toEqual([{ n: 1 }, { n: 2 }]);
      expect(boundary.cursor.offset).toBe(16);
    },
  });
  await expect(running).rejects.toThrow();
  expect(values).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await appendFile(path, '{"n":4}\n');
  const resumed = new AbortController();
  await expect(
    followJsonlSource(path, {
      signal: resumed.signal,
      after: cursor!,
      pollMs: 1,
      commit: async (record) => {
        values.push(record.value);
        resumed.abort();
      },
    }),
  ).rejects.toThrow();
  expect(values).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});
it("leaves failed consumer commits replayable and rejects a rewritten acknowledged prefix", async () => {
  const { followJsonlSource } =
    await import("../../packages/adapters/src/index.js");
  const path = await source('{"n":1}\n');
  const first = (await read(path))[0]!;
  await expect(
    followJsonlSource(path, {
      signal: AbortSignal.timeout(1000),
      commit: async () => {
        throw new Error("durable commit failed");
      },
    }),
  ).rejects.toThrow("durable commit failed");
  await writeFile(path, '{"n":2}\n{"n":3}\n');
  let commits = 0;
  await expect(
    followJsonlSource(path, {
      signal: AbortSignal.timeout(1000),
      after: first.cursor,
      commit: async () => {
        commits++;
      },
    }),
  ).rejects.toThrow("prefix changed");
  expect(commits).toBe(0);
});
it("verifies an imported suffix without LF after growth but requires LF for reading new records", async () => {
  const path = await source('{"n":1}');
  const cursor = (await read(path, { tail: "parse" }))[0]!.cursor;
  await appendFile(path, '\n{"n":2}\n');
  expect(await read(path, { after: cursor, through: cursor.offset })).toEqual(
    [],
  );
  await expect(read(path, { after: cursor })).rejects.toThrow(
    "complete-line boundary",
  );
  expect((await read(path)).map((record) => record.value)).toEqual([
    { n: 1 },
    { n: 2 },
  ]);
});
