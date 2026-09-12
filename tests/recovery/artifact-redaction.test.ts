import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactSpool,
  PublisherJournal,
  type ArtifactCapture,
  type CapturedAttachment,
} from "../../packages/publisher/src/index.js";
import { localArtifactResolver } from "../../packages/adapters/src/index.js";
import { openCodeFileEvents } from "../../packages/adapters/src/opencode-artifacts.js";
import {
  inspectClaudeHistory,
  createClaudeHistoryConsumer,
} from "../../packages/adapters/src/claude-history.js";
import { readJsonlSource } from "../../packages/adapters/src/jsonl.js";

const SECRET = "synthetic-secret-value-0123456789";
const directories: string[] = [];
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function workspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `agentlive-${name}-`));
  directories.push(root);
  const source = join(root, "source");
  await mkdir(source);
  return { root, source };
}
async function openSpool(
  root: string,
  source: string,
  options: { secrets?: string[]; redaction?: 1 | 2 } = {},
) {
  const spool = await ArtifactSpool.open(join(root, "spool"), {
    allowedRoots: [source],
    secrets: options.secrets ?? [SECRET],
    ...(options.redaction === undefined
      ? {}
      : { redaction: options.redaction }),
  });
  closers.push(spool);
  return spool;
}
async function stored(spool: ArtifactSpool, attachment: CapturedAttachment) {
  const file = await spool.openFile(attachment);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
}
/** Uploads are answered as already durable; capture is what these tests cover. */
function withoutUploads() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/status?"))
      return Response.json({ available: true });
    throw new Error(`Unexpected request to ${String(url)}`);
  }) as typeof fetch;
  return { close: async () => void (globalThis.fetch = original) };
}

it("redacts captured files whose declared type is not text", async () => {
  const { root, source } = await workspace("artifact-sniff");
  const spool = await openSpool(root, source);
  const captured: CapturedAttachment[] = [];
  for (const name of [
    "deploy.py",
    "run.sh",
    ".env",
    "pom.xml",
    "config.toml",
    "Makefile",
  ]) {
    const path = join(source, name);
    await writeFile(path, `prefix ${SECRET} suffix\n`);
    const input: ArtifactCapture = {
      artifactId: "artifact",
      sourceKey: name,
      path,
      // Exactly what the extension allowlist produces for these names.
      mediaType: "application/octet-stream",
      text: false,
      historical: true,
    };
    const attachment = await spool.capture(input);
    expect(await stored(spool, attachment)).toEqual(
      Buffer.from("prefix [REDACTED] suffix\n"),
    );
    // The raw source hash still describes the unfiltered file.
    expect(attachment.sourceHash).not.toBe(attachment.hash);
    captured.push(attachment);
  }
  expect(new Set(captured.map((item) => item.hash)).size).toBe(1);
});

it("redacts unlisted extensions through the local artifact resolver", async () => {
  const { root } = await workspace("artifact-resolver");
  closers.push(withoutUploads());
  const resolver = await localArtifactResolver({
    directory: join(root, "artifacts"),
    roots: [root],
    baseDirectory: root,
    secrets: [SECRET],
    serverOrigin: "http://localhost:1",
    streamId: "stream",
    writeSecret: "unused",
    signal: new AbortController().signal,
  });
  closers.push(resolver);
  const captured: CapturedAttachment[] = [];
  for (const name of ["script.py", "settings.env", "build.xml", "Dockerfile"]) {
    await writeFile(join(root, name), `line\n${SECRET}\n`);
    const result = await resolver.resolveArtifact({
      artifactId: "artifact",
      sourceKey: name,
      path: name,
      historical: true,
    });
    expect(result).toHaveProperty("attachment");
    if (!("attachment" in result)) throw new Error("capture failed");
    expect(result.attachment.mediaType).toBe("application/octet-stream");
    captured.push(result.attachment);
  }
  await resolver.close();
  closers.pop();
  const spool = await ArtifactSpool.open(join(root, "artifacts", "capture"), {
    allowedRoots: [root],
  });
  closers.push(spool);
  expect(spool.redaction).toBe(2);
  for (const attachment of captured)
    expect(await stored(spool, attachment)).toEqual(
      Buffer.from("line\n[REDACTED]\n"),
    );
});

it("redacts inline captures that declare a binary media type", async () => {
  const { root, source } = await workspace("artifact-inline");
  const spool = await openSpool(root, source);
  const attachment = await spool.captureInline({
    artifactId: "artifact",
    sourceKey: "inline",
    bytes: Buffer.from(`token=${SECRET}`),
    filename: "attachment.bin",
    mediaType: "application/octet-stream",
    text: false,
    historical: true,
  });
  expect(await stored(spool, attachment)).toEqual(
    Buffer.from("token=[REDACTED]"),
  );
});

it("redacts an OpenCode attachment declaring application/octet-stream", async () => {
  const { root } = await workspace("artifact-opencode");
  closers.push(withoutUploads());
  const resolver = await localArtifactResolver({
    directory: join(root, "artifacts"),
    roots: [root],
    baseDirectory: root,
    secrets: [SECRET],
    serverOrigin: "http://localhost:1",
    streamId: "stream",
    writeSecret: "unused",
    signal: new AbortController().signal,
  });
  closers.push(resolver);
  const events = await openCodeFileEvents({
    part: {
      url: `data:application/octet-stream;base64,${Buffer.from(
        `export KEY=${SECRET}`,
      ).toString("base64")}`,
      mime: "application/octet-stream",
      filename: "notes.bin",
    },
    artifactId: "message_part",
    messageId: "message",
    sourceScope: "session",
    resolvers: resolver,
    filter: (text) => text,
  });
  const available = events.find(
    (event) => event.kind === "attachment.available",
  );
  expect(available).toBeDefined();
  if (available?.kind !== "attachment.available") throw new Error("missing");
  await resolver.close();
  closers.pop();
  const spool = await ArtifactSpool.open(join(root, "artifacts", "capture"), {
    allowedRoots: [root],
  });
  closers.push(spool);
  expect(await stored(spool, available.payload.attachment)).toEqual(
    Buffer.from("export KEY=[REDACTED]"),
  );
});

it("redacts a Claude inline attachment declaring an image media type", async () => {
  const { root } = await workspace("artifact-claude");
  closers.push(withoutUploads());
  const journal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: "http://localhost:1",
    agent: "claude",
    nativeSessionId: "session",
  });
  closers.push(journal);
  await journal.bindRemote("stream", "revision");
  const resolver = await localArtifactResolver({
    directory: join(root, "artifacts"),
    roots: [root],
    baseDirectory: root,
    secrets: [SECRET],
    serverOrigin: "http://localhost:1",
    streamId: "stream",
    writeSecret: "unused",
    signal: new AbortController().signal,
  });
  closers.push(resolver);
  const path = join(root, "history.jsonl");
  await writeFile(
    path,
    JSON.stringify({
      type: "user",
      sessionId: "session",
      uuid: "message_uuid",
      timestamp: "2026-09-01T00:00:00Z",
      message: {
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from(`<svg>${SECRET}</svg>`).toString("base64"),
            },
          },
        ],
      },
    }) + "\n",
  );
  const manifest = await inspectClaudeHistory(path);
  const consumer = await createClaudeHistoryConsumer(
    manifest,
    journal,
    [SECRET],
    resolver.resolveInline,
  );
  for await (const record of readJsonlSource(path))
    await consumer.accept(record);
  const events = [];
  for await (const event of journal.pending(0)) events.push(event.content);
  const available = events.find(
    (event) => event.kind === "attachment.available",
  );
  expect(available).toBeDefined();
  if (available?.kind !== "attachment.available") throw new Error("missing");
  await resolver.close();
  closers.pop();
  const spool = await ArtifactSpool.open(join(root, "artifacts", "capture"), {
    allowedRoots: [root],
  });
  closers.push(spool);
  expect(await stored(spool, available.payload.attachment)).toEqual(
    Buffer.from("<svg>[REDACTED]</svg>"),
  );
});

it("round-trips genuinely binary bytes and redacts secrets embedded in them", async () => {
  const { root, source } = await workspace("artifact-binary");
  const spool = await openSpool(root, source);
  const image = await readFile(
    join(import.meta.dirname, "..", "fixtures", "images", "pixel.jpg"),
  );
  const clean = join(source, "pixel.jpg");
  await writeFile(clean, image);
  const base: ArtifactCapture = {
    artifactId: "artifact",
    sourceKey: "clean",
    path: clean,
    mediaType: "image/jpeg",
    text: false,
    historical: true,
  };
  const untouched = await spool.capture(base);
  expect(await stored(spool, untouched)).toEqual(image);
  expect(untouched.hash).toBe(untouched.sourceHash);
  const tainted = join(source, "tainted.jpg");
  await writeFile(
    tainted,
    Buffer.concat([image, Buffer.from(SECRET), image.subarray(0, 32)]),
  );
  const captured = await spool.capture({
    ...base,
    sourceKey: "tainted",
    path: tainted,
  });
  expect(await stored(spool, captured)).toEqual(
    Buffer.concat([image, Buffer.from("[REDACTED]"), image.subarray(0, 32)]),
  );
  // The same bytes inline take the same path.
  const inline = await spool.captureInline({
    artifactId: "artifact",
    sourceKey: "inline",
    bytes: Buffer.concat([image, Buffer.from(SECRET)]),
    filename: "pixel.jpg",
    mediaType: "image/jpeg",
    text: false,
    historical: true,
  });
  expect(await stored(spool, inline)).toEqual(
    Buffer.concat([image, Buffer.from("[REDACTED]")]),
  );
});

it("redacts across streaming chunk boundaries without splitting characters", async () => {
  const { root, source } = await workspace("artifact-boundary");
  const spool = await openSpool(root, source);
  // 65536-byte reads: the secret straddles the first boundary and a four-byte
  // character straddles the second.
  const head = "a".repeat(65536 - 5);
  const filler = "b".repeat(131070 - (head.length + SECRET.length));
  const text = head + SECRET + filler + "🌧" + "tail";
  const path = join(source, "large.py");
  await writeFile(path, text);
  const input: ArtifactCapture = {
    artifactId: "artifact",
    sourceKey: "large",
    path,
    mediaType: "application/octet-stream",
    text: false,
    historical: true,
  };
  const attachment = await spool.capture(input);
  expect(await stored(spool, attachment)).toEqual(
    Buffer.from(head + "[REDACTED]" + filler + "🌧" + "tail"),
  );
  // The same boundary handling applies to the byte-level scan of binary bytes.
  const binary = join(source, "large.bin");
  await writeFile(
    binary,
    Buffer.concat([
      Buffer.alloc(65536 - 5, 0xff),
      Buffer.from(SECRET),
      Buffer.alloc(64, 0xfe),
    ]),
  );
  const captured = await spool.capture({
    ...input,
    sourceKey: "large-binary",
    path: binary,
  });
  expect(await stored(spool, captured)).toEqual(
    Buffer.concat([
      Buffer.alloc(65536 - 5, 0xff),
      Buffer.from("[REDACTED]"),
      Buffer.alloc(64, 0xfe),
    ]),
  );
});

it("reuses immutable bytes on retry under a pinned policy", async () => {
  const { root, source } = await workspace("artifact-retry");
  const spool = await openSpool(root, source);
  const path = join(source, "script.sh");
  await writeFile(path, `echo ${SECRET}`);
  const input: ArtifactCapture = {
    artifactId: "artifact",
    sourceKey: "retry",
    path,
    mediaType: "application/octet-stream",
    text: false,
    historical: true,
  };
  const first = await spool.capture(input);
  await writeFile(path, "echo replaced");
  expect(await spool.capture(input)).toEqual(first);
  await spool.close();
  closers.pop();
  const resumed = await openSpool(root, source);
  expect(resumed.redaction).toBe(2);
  expect(await resumed.capture(input)).toEqual(first);
  expect(await stored(resumed, first)).toEqual(Buffer.from("echo [REDACTED]"));
  expect(
    JSON.parse(await readFile(join(root, "spool", "policy.json"), "utf8")),
  ).toEqual({ version: 1, artifactRedaction: 2 });
});

it("keeps existing captures on the declared-text rule and refuses to switch", async () => {
  const { root, source } = await workspace("artifact-legacy");
  const legacy = await openSpool(root, source, { redaction: 1 });
  expect(legacy.redaction).toBe(1);
  const path = join(source, "deploy.py");
  await writeFile(path, `token ${SECRET}`);
  const input: ArtifactCapture = {
    artifactId: "artifact",
    sourceKey: "legacy",
    path,
    mediaType: "application/octet-stream",
    text: false,
    historical: true,
  };
  const captured = await legacy.capture(input);
  expect(await stored(legacy, captured)).toEqual(
    Buffer.from(`token ${SECRET}`),
  );
  await legacy.close();
  closers.pop();
  // A spool that already holds captures keeps its rule even without the marker.
  await rm(join(root, "spool", "policy.json"));
  const detected = await openSpool(root, source);
  expect(detected.redaction).toBe(1);
  expect(await detected.capture(input)).toEqual(captured);
  await detected.close();
  closers.pop();
  await expect(
    ArtifactSpool.open(join(root, "spool"), {
      allowedRoots: [source],
      secrets: [SECRET],
      redaction: 2,
    }),
  ).rejects.toThrow(/redaction policy changed/);
  // An empty directory adopts the current rule.
  const fresh = await ArtifactSpool.open(join(root, "fresh"), {
    allowedRoots: [source],
  });
  closers.push(fresh);
  expect(fresh.redaction).toBe(2);
});

it("matches secret bytes at any chunk size and prefers the longest match", async () => {
  const { StreamingByteRedactor } =
    await import("../../packages/publisher/src/filter.js");
  const payload = Buffer.concat([
    Buffer.alloc(3, 0xff),
    Buffer.from(SECRET),
    Buffer.alloc(2, 0x00),
    Buffer.from("abcdef"),
    Buffer.alloc(1, 0xfe),
  ]);
  const expected = Buffer.concat([
    Buffer.alloc(3, 0xff),
    Buffer.from("[REDACTED]"),
    Buffer.alloc(2, 0x00),
    Buffer.from("[REDACTED]"),
    Buffer.alloc(1, 0xfe),
  ]);
  for (const size of [1, 2, 7, 33, 4096]) {
    const redactor = new StreamingByteRedactor([SECRET, "abc", "abcdef"]);
    const output = [];
    for (let offset = 0; offset < payload.length; offset += size)
      output.push(redactor.push(payload.subarray(offset, offset + size)));
    output.push(redactor.finish());
    expect(Buffer.concat(output)).toEqual(expected);
  }
  const empty = new StreamingByteRedactor([SECRET]);
  expect(Buffer.concat([empty.push(Buffer.alloc(0)), empty.finish()])).toEqual(
    Buffer.alloc(0),
  );
  expect(() => empty.push(Buffer.alloc(1))).toThrow(/closed/);
});

it("preserves a byte-order mark while filtering the text after it", async () => {
  const { root, source } = await workspace("artifact-bom");
  const spool = await openSpool(root, source);
  const path = join(source, "notes.txt");
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`key ${SECRET}\n`),
  ]);
  await writeFile(path, bytes);
  const attachment = await spool.capture({
    artifactId: "artifact",
    sourceKey: "bom",
    path,
    mediaType: "text/plain",
    text: true,
    historical: true,
  });
  expect(await stored(spool, attachment)).toEqual(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("key [REDACTED]\n"),
    ]),
  );
  const inline = await spool.captureInline({
    artifactId: "artifact",
    sourceKey: "bom-inline",
    bytes,
    filename: "notes.txt",
    mediaType: "application/octet-stream",
    text: false,
    historical: true,
  });
  expect(inline.hash).toBe(attachment.hash);
});
