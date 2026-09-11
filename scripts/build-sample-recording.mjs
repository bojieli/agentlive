#!/usr/bin/env node
// Build docs/sample/agentlive-sample.agentlive from a synthetic Claude Code
// transcript through the real CLI: serve -> import -> export. No model calls and
// no private data. Run after `pnpm build`:
//   node scripts/build-sample-recording.mjs [output]
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/cli/dist/main.js");
const output = resolve(
  process.argv[2] ?? join(root, "docs/sample/agentlive-sample.agentlive"),
);
const env = { PATH: process.env.PATH ?? "" };

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
/** A small deterministic RGB gradient PNG. */
function samplePng(width = 64, height = 40) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++)
      row.set(
        [
          Math.round((x / width) * 60 + 30),
          Math.round((y / height) * 90 + 110),
          90,
        ],
        1 + x * 3,
      );
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const session = "sample_session";
const start = Date.parse("2026-09-01T09:00:00.000Z");
let clock = 0,
  sequence = 0;
const row = (type, content, seconds) => {
  clock += seconds * 1000;
  return JSON.stringify({
    type,
    sessionId: session,
    uuid: `sample-${++sequence}`,
    timestamp: new Date(start + clock).toISOString(),
    message: { role: type, content },
  });
};
const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, content, is_error = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error,
});
const transcript = [
  row(
    "user",
    [
      {
        type: "text",
        text: "The `slugify` test is failing on titles with accents. Here is the CI screenshot — can you fix it?",
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: samplePng().toString("base64"),
        },
      },
    ],
    0,
  ),
  row(
    "assistant",
    [
      {
        type: "text",
        text: "I'll reproduce the failure first, then look at the implementation.",
      },
      tool("t1", "Bash", { command: "npm test -- slugify" }),
    ],
    4,
  ),
  row(
    "user",
    [
      result(
        "t1",
        'FAIL src/slugify.test.js\n  ✕ strips accents (4 ms)\n    Expected: "creme-brulee"\n    Received: "crme-brle"\n\nTests: 1 failed, 5 passed',
        true,
      ),
    ],
    6,
  ),
  row(
    "assistant",
    [
      {
        type: "text",
        text: "The accented characters are being dropped instead of transliterated. Let me read the function.",
      },
      tool("t2", "Read", { file_path: "src/slugify.js" }),
    ],
    3,
  ),
  row(
    "user",
    [
      result(
        "t2",
        'export function slugify(title) {\n  return title\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-|-$/g, "");\n}\n',
      ),
    ],
    1,
  ),
  row(
    "assistant",
    [
      {
        type: "text",
        text: "Normalizing to NFD and removing combining marks before the ASCII filter keeps the base letters.",
      },
      tool("t3", "Edit", {
        file_path: "src/slugify.js",
        old_string: "    .toLowerCase()\n",
        new_string:
          '    .normalize("NFD")\n    .replace(/[\\u0300-\\u036f]/g, "")\n    .toLowerCase()\n',
      }),
    ],
    9,
  ),
  row("user", [result("t3", "The file src/slugify.js has been updated.")], 1),
  row("assistant", [tool("t4", "Bash", { command: "npm test -- slugify" })], 3),
  row(
    "user",
    [result("t4", "PASS src/slugify.test.js\n\nTests: 6 passed, 6 total")],
    5,
  ),
  row(
    "assistant",
    [
      {
        type: "text",
        text: 'Fixed. `slugify` now strips diacritics via Unicode normalization, so "Crème Brûlée" becomes `creme-brulee`. All six slugify tests pass.',
      },
    ],
    4,
  ),
];

const work = await mkdtemp(join(tmpdir(), "agentlive-sample-"));
const server = spawn(
  process.execPath,
  [cli, "serve", "--state-dir", work, "--port", "0"],
  { env, stdio: ["ignore", "pipe", "inherit"] },
);
const exited = new Promise((resolve) => server.once("exit", resolve));
try {
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: server.stdout });
    lines.once("line", (line) => {
      lines.close();
      resolve(JSON.parse(line));
    });
    server.once("exit", () => reject(new Error("Server exited early")));
  });
  const source = join(work, "sample.jsonl");
  await writeFile(source, transcript.join("\n") + "\n");
  const common = ["--state-dir", work, "--server", ready.url];
  const imported = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "import",
          "--agent",
          "claude",
          "--source",
          source,
          "--title",
          "Sample: fixing accent handling in slugify",
          "--visibility",
          "public",
          ...common,
        ],
        { env },
      )
    ).stdout,
  );
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await exec(
    process.execPath,
    [
      cli,
      "export",
      "--stream",
      imported.streamId,
      "--output",
      output,
      ...common,
    ],
    { env },
  );
  console.log(
    JSON.stringify({ output, producerEvents: imported.producerEvents }),
  );
} finally {
  server.kill("SIGTERM");
  await exited;
  await rm(work, { recursive: true, force: true });
}
