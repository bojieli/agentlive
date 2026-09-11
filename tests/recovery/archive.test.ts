import { expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
const { ZipFile } = createRequire(
  new URL("../../packages/storage/package.json", import.meta.url),
)("yazl");
import {
  openArchive,
  writeArchive,
  type ArchiveMetadata,
} from "../../packages/storage/src/archive.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const date = "2026-09-10T00:00:00Z";
const attachment = Buffer.from("portable attachment 🦊");
const hash = createHash("sha256").update(attachment).digest("hex");
const events: StoredEvent[] = [
  {
    protocolVersion: 1,
    serverSeq: 1,
    timelineMs: 0,
    receivedAt: date,
    origin: { type: "server", operationId: "created" },
    content: {
      kind: "attachment.available",
      payload: {
        attachment: {
          artifactId: "a",
          version: 1,
          filename: "sample.txt",
          mediaType: "text/plain",
          hash,
          byteSize: attachment.length,
        },
      },
    },
  },
];
const metadata: ArchiveMetadata = {
  format: "agentlive.recording",
  version: 1,
  protocolVersion: 1,
  reducerVersion: 1,
  exportedAt: date,
  recording: {
    streamId: "source",
    revision: "revision",
    title: "Portable",
    createdAt: date,
    throughServerSeq: 1,
    timelineMs: 0,
    lifecycle: "open",
  },
  provenance: {
    agent: "synthetic",
    sourceVersion: null,
    adapterVersion: null,
    capabilities: [],
    completeness: "captured-prefix",
    gapCount: 0,
  },
};
const source = async function* () {
  yield* events;
};
it.each([
  "duplicate",
  "executable",
  "symlink",
  "extra",
  "hash",
  "version",
  "traversal",
])("rejects %s archive entries before exposing content", async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), "archive-bad-test-"));
  try {
    const eventBytes = Buffer.from(
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const manifest = {
      ...metadata,
      files: [
        {
          path: "events.jsonl",
          byteSize: eventBytes.length,
          hash: createHash("sha256").update(eventBytes).digest("hex"),
        },
        { path: `attachments/${hash}`, byteSize: attachment.length, hash },
      ],
    };
    if (failure === "hash") manifest.files[0]!.hash = "0".repeat(64);
    if (failure === "version") (manifest as any).version = 2;
    const zip = new ZipFile();
    const path = join(directory, "bad.agentlive");
    const completed = pipeline(zip.outputStream, createWriteStream(path));
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
    zip.addBuffer(eventBytes, "events.jsonl", {
      mode:
        failure === "executable"
          ? 0o100755
          : failure === "symlink"
            ? 0o120600
            : 0o100600,
    });
    zip.addBuffer(attachment, `attachments/${hash}`);
    if (failure === "duplicate") zip.addBuffer(eventBytes, "events.jsonl");
    if (failure === "extra")
      zip.addBuffer(Buffer.from("not recording data"), "script.js");
    zip.end();
    await completed;
    if (failure === "traversal") {
      const bytes = await readFile(path);
      let offset = 0;
      while ((offset = bytes.indexOf("events.jsonl", offset)) !== -1) {
        bytes.write("../evil.json", offset, "utf8");
        offset += 12;
      }
      await writeFile(path, bytes);
    }
    await expect(openArchive(path)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("round trips exact events and attachment bytes without replacing an existing export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-test-"));
  try {
    const path = join(directory, "session.agentlive");
    const manifest = await writeArchive(path, metadata, source(), async () =>
      Readable.from([attachment]),
    );
    const archive = await openArchive(path);
    try {
      expect(archive.manifest).toEqual(manifest);
      const received = [];
      for await (const event of archive.events()) received.push(event);
      expect(received).toEqual(events);
      const chunks = [];
      for await (const chunk of archive.attachment(hash)) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(attachment);
    } finally {
      await archive.close();
    }
    expect(() => archive.attachment(hash)).toThrow("closed");
    const original = await readFile(path);
    await expect(
      writeArchive(path, metadata, source(), async () =>
        Readable.from([attachment]),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path)).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects missing bytes and a manifest that disagrees with the event prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-test-"));
  try {
    await expect(
      writeArchive(
        join(directory, "bad.agentlive"),
        metadata,
        source(),
        async () => Readable.from([Buffer.from("bad")]),
      ),
    ).rejects.toThrow("attachment bytes differ");
    await expect(
      writeArchive(
        join(directory, "boundary.agentlive"),
        {
          ...metadata,
          recording: { ...metadata.recording, throughServerSeq: 2 },
        },
        source(),
        async () => Readable.from([attachment]),
      ),
    ).rejects.toThrow("boundary/count mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves cancellation identity before reading an archive event range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-cancel-range-"));
  try {
    const path = join(directory, "recording.agentlive");
    await writeArchive(path, metadata, source(), async () =>
      Readable.from([attachment]),
    );
    const archive = await openArchive(path);
    try {
      const stop = new AbortController();
      const reason = new Error("Replay position changed");
      stop.abort(reason);
      await expect(archive.events(stop.signal).next()).rejects.toBe(reason);
      const during = new AbortController();
      const iterator = archive.events(during.signal);
      expect((await iterator.next()).value?.serverSeq).toBe(1);
      during.abort(reason);
      await expect(iterator.next()).rejects.toBe(reason);
    } finally {
      await archive.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
