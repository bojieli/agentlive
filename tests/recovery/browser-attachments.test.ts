import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import {
  loadAttachment,
  pngPreviewSize,
  textPreview,
  type Attachment,
} from "../../apps/web/src/attachments.js";
function descriptor(bytes: Uint8Array): Attachment {
  return {
    artifactId: "image",
    version: 1,
    hash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    filename: "example.png",
    mediaType: "image/png",
  };
}
function chunk(type: string, bytes = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), bytes]),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function png(width = 1, height = 1, extra = Buffer.alloc(0)) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    extra,
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND"),
  ]);
}
it("loads only the announced bytes and verifies their hash using explicit authorization", async () => {
  const bytes = png(),
    attachment = descriptor(bytes);
  const fetcher = vi.fn(async () => new Response(bytes));
  const loaded = await loadAttachment(
    attachment,
    "recording",
    "test-secret",
    new AbortController().signal,
    "http://localhost:7331",
    fetcher,
  );
  expect(Buffer.from(loaded)).toEqual(bytes);
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    `http://localhost:7331/api/v1/streams/recording/attachments/${attachment.hash}`,
  );
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    headers: { authorization: "Bearer test-secret" },
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  expect(pngPreviewSize(loaded)).toEqual({ width: 1, height: 1 });
});
it.each(["hash", "short", "long", "denied"])(
  "refuses %s responses before exposing attachment bytes",
  async (mode) => {
    const bytes = png(),
      attachment = descriptor(bytes);
    const returned =
      mode === "short"
        ? bytes.subarray(1)
        : mode === "long"
          ? Buffer.concat([bytes, Buffer.from([0])])
          : Buffer.from(bytes);
    if (mode === "hash") returned[returned.length - 1] ^= 1;
    await expect(
      loadAttachment(
        attachment,
        "recording",
        "",
        new AbortController().signal,
        "http://localhost",
        async () =>
          new Response(returned, { status: mode === "denied" ? 403 : 200 }),
      ),
    ).rejects.toThrow();
  },
);
it("rejects oversize metadata and pre-aborted requests before fetching", async () => {
  const fetcher = vi.fn(),
    attachment = descriptor(png()),
    stop = new AbortController();
  await expect(
    loadAttachment(
      { ...attachment, byteSize: 26 * 1024 * 1024 },
      "recording",
      "",
      stop.signal,
      "http://localhost",
      fetcher,
    ),
  ).rejects.toThrow("25 MiB");
  stop.abort(new Error("Left recording"));
  await expect(
    loadAttachment(
      attachment,
      "recording",
      "",
      stop.signal,
      "http://localhost",
      fetcher,
    ),
  ).rejects.toThrow("Left recording");
  expect(fetcher).not.toHaveBeenCalled();
});
it("cancels a stalled body without awaiting an uncooperative cancellation callback", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    pull() {
      entered();
    },
    cancel,
  });
  const stop = new AbortController();
  const work = loadAttachment(
    descriptor(png()),
    "recording",
    "",
    stop.signal,
    "http://localhost",
    async () => new Response(body),
  );
  const rejected = expect(work).rejects.toThrow("Left recording");
  await waiting;
  stop.abort(new Error("Left recording"));
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});
it("limits PNG dimensions, animation, compressed metadata, malformed chunks and trailing data", () => {
  for (const bytes of [
    png(0),
    png(8193),
    png(8192, 8192),
    png(1, 1, chunk("acTL", Buffer.alloc(8))),
    png(1, 1, chunk("iCCP")),
    png().subarray(0, 35),
    Buffer.concat([png(), Buffer.from([0])]),
    Buffer.from("<svg onload='alert(1)'/>"),
  ])
    expect(pngPreviewSize(bytes)).toBeUndefined();
});
it("returns markup as plain UTF-8 text and rejects oversized or invalid text previews", () => {
  const markup = "<script>alert(1)</script>";
  expect(textPreview(Buffer.from(markup), "text/html")).toBe(markup);
  expect(textPreview(Buffer.from("<svg/>"), "image/svg+xml")).toBe("<svg/>");
  expect(textPreview(Buffer.from([255]), "text/plain")).toBeUndefined();
  expect(
    textPreview(new Uint8Array(1024 * 1024 + 1), "text/plain"),
  ).toBeUndefined();
  expect(
    textPreview(Buffer.from("content"), "application/octet-stream"),
  ).toBeUndefined();
});
