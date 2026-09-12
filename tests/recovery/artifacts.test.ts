import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ArtifactSpool,
  uploadArtifact,
  type ArtifactCapture,
} from "../../packages/publisher/src/index.js";
const roots: string[] = [],
  spools: ArtifactSpool[] = [];
afterEach(async () => {
  for (const spool of spools.splice(0)) await spool.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(secrets: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-artifacts-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const options = { allowedRoots: [source], secrets };
  const directory = join(root, "spool");
  const spool = await ArtifactSpool.open(directory, options);
  spools.push(spool);
  const input: ArtifactCapture = {
    artifactId: "artifact",
    sourceKey: "item1",
    path: join(source, "result.txt"),
    mediaType: "text/plain",
    text: true,
    historical: true,
  };
  return { root, source, directory, options, spool, input };
}
it("persists original bytes across restart and missing sources, with immutable versions", async () => {
  const { spool, input, directory, options } = await setup();
  await writeFile(input.path, "first");
  const first = await spool.capture(input);
  expect(first.provenance).toBe("current-file");
  await writeFile(input.path, "second");
  expect(await spool.capture(input)).toEqual(first);
  const second = await spool.capture({ ...input, sourceKey: "item2" });
  expect(second.version).toBe(2);
  expect(second.hash).not.toBe(first.hash);
  await spool.close();
  await rm(input.path);
  const resumed = await ArtifactSpool.open(directory, options);
  spools.push(resumed);
  expect(await resumed.capture(input)).toEqual(first);
  const file = await resumed.openFile(first);
  try {
    expect(await file.readFile("utf8")).toBe("first");
  } finally {
    await file.close();
  }
  await expect(
    resumed.capture({ ...input, historical: false }),
  ).rejects.toThrow(/policy changed/);
});
it("redacts secrets across read boundaries and verifies historical raw hashes", async () => {
  const secret = "synthetic-secret-value";
  const { spool, input } = await setup([secret]);
  const text = "x".repeat(65530) + secret + "雨🌧️";
  await writeFile(input.path, text);
  const sourceHash = createHash("sha256").update(text).digest("hex");
  const captured = await spool.capture({
    ...input,
    expectedSourceHash: sourceHash,
  });
  expect(captured.provenance).toBe("historical-version");
  expect(captured.sourceHash).toBe(sourceHash);
  const file = await spool.openFile(captured);
  try {
    expect(await file.readFile("utf8")).toBe(
      text.replace(secret, "[REDACTED]"),
    );
  } finally {
    await file.close();
  }
  await expect(
    spool.capture({
      ...input,
      sourceKey: "wrong",
      expectedSourceHash: "0".repeat(64),
    }),
  ).rejects.toThrow(/hash does not match/);
});
it("rejects escaped roots and missing files; captures undecodable and empty files", async () => {
  const { spool, input, root } = await setup();
  const outside = join(root, "outside");
  await writeFile(outside, "private");
  await symlink(outside, input.path);
  await expect(spool.capture(input)).rejects.toThrow(/outside configured/);
  await rm(input.path);
  await expect(spool.capture(input)).rejects.toThrow();
  // Declared text that does not decode is stored as bytes rather than failing.
  await writeFile(input.path, Buffer.from([0xff]));
  const undecodable = await spool.capture({ ...input, sourceKey: "bytes" });
  expect(undecodable.byteSize).toBe(1);
  const stored = await spool.openFile(undecodable);
  try {
    expect(await stored.readFile()).toEqual(Buffer.from([0xff]));
  } finally {
    await stored.close();
  }
  await writeFile(input.path, "");
  const empty = await spool.capture(input);
  expect(empty.byteSize).toBe(0);
});
it("resolves a lost upload ACK by hash without recapturing changed source bytes", async () => {
  const { spool, input } = await setup();
  await writeFile(input.path, "original");
  const captured = await spool.capture(input);
  let uploaded: Uint8Array | undefined;
  let posts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/status?"))
      return Response.json({ available: uploaded !== undefined });
    posts++;
    uploaded = new Uint8Array(await new Response(init!.body).arrayBuffer());
    await writeFile(input.path, "changed");
    throw new TypeError("connection lost after durable upload");
  };
  await uploadArtifact(spool, captured, {
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    writeSecret: "secret",
    signal: AbortSignal.timeout(5000),
    fetch: fetcher,
    retryMinMs: 1,
  });
  expect(posts).toBe(1);
  expect(Buffer.from(uploaded!).toString()).toBe("original");
});
it("uploads binary and empty attachments to the real HTTP server before publication", async () => {
  const { startServer } = await import("../../packages/server/src/http.js");
  const { spool, input, root } = await setup();
  const ownerSecret = "b".repeat(64),
    writeSecret = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret,
    port: 0,
  });
  try {
    const response = await fetch(`${server.url}/api/v1/streams`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "artifact_test",
        requestedAt: new Date().toISOString(),
        publisherId: "publisher",
        producerEpoch: "epoch",
        writeSecret,
        title: "Artifacts",
        visibility: "private",
      }),
    });
    expect(response.status).toBe(201);
    const { streamId } = (await response.json()) as { streamId: string };
    for (const bytes of [
      Buffer.from([0, 255, 137, 80, 78, 71]),
      Buffer.alloc(0),
    ]) {
      await writeFile(input.path, bytes);
      const attachment = await spool.capture({
        ...input,
        sourceKey: `bytes_${bytes.length}`,
        text: false,
        mediaType: "application/octet-stream",
      });
      await uploadArtifact(spool, attachment, {
        serverOrigin: server.url,
        streamId,
        writeSecret,
        signal: AbortSignal.timeout(5000),
      });
      const status = await fetch(
        `${server.url}/api/v1/streams/${streamId}/attachments/${attachment.hash}/status?byteSize=${attachment.byteSize}`,
        { headers: { authorization: `Bearer ${writeSecret}` } },
      );
      expect(await status.json()).toEqual({ available: true });
      // Stored but unannounced bytes cannot yet be downloaded.
      const download = await fetch(
        `${server.url}/api/v1/streams/${streamId}/attachments/${attachment.hash}`,
        { headers: { authorization: `Bearer ${writeSecret}` } },
      );
      expect(download.ok).toBe(false);
    }
  } finally {
    await server.close();
  }
});
it("captures immutable inline bytes and filters inline text without writing raw source bytes", async () => {
  const { spool } = await setup(["private-inline-secret"]);
  const bytes = Buffer.from("private-inline-secret retained text");
  const input = {
    artifactId: "inline",
    sourceKey: "source",
    bytes,
    filename: "note.txt",
    mediaType: "text/plain",
    text: true,
    historical: true,
  };
  const promise = spool.captureInline(input);
  bytes.fill(0);
  const attachment = await promise;
  expect(attachment.provenance).toBe("historical-version");
  const file = await spool.openFile(attachment);
  try {
    expect(await file.readFile("utf8")).toBe("[REDACTED] retained text");
  } finally {
    await file.close();
  }
  expect(
    await spool.captureInline({
      ...input,
      bytes: Buffer.from("private-inline-secret retained text"),
    }),
  ).toEqual(attachment);
  await expect(spool.captureInline(input)).rejects.toThrow(
    /identity or capture policy changed/,
  );
});
