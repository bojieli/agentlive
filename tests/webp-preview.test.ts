import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { webpPreviewSize, rasterPreview } from "../apps/web/src/attachments.js";
const chunk = (type: string, bytes: Uint8Array) => {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, Buffer.alloc(bytes.length & 1)]);
};
const riff = (...chunks: Uint8Array[]) => {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};
it("accepts a real static WebP and rejects corrupt framing and animation", async () => {
  const bytes = await readFile(
    new URL("./fixtures/images/pixel.webp", import.meta.url),
  );
  expect(webpPreviewSize(bytes)).toEqual({ width: 2, height: 3 });
  expect(rasterPreview(bytes, "image/webp")?.mediaType).toBe("image/webp");
  expect(rasterPreview(bytes, "image/jpeg")).toBeUndefined();
  expect(webpPreviewSize(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
  expect(
    webpPreviewSize(Buffer.concat([bytes, Buffer.from([0])])),
  ).toBeUndefined();
  const animated = riff(chunk("ANIM", new Uint8Array(6)), bytes.subarray(12));
  expect(webpPreviewSize(animated)).toBeUndefined();
  const canvas = Buffer.alloc(10);
  canvas[0] = 2;
  expect(
    webpPreviewSize(riff(chunk("VP8X", canvas), bytes.subarray(12))),
  ).toBeUndefined();
  expect(webpPreviewSize(new Uint8Array(8 * 1024 * 1024 + 1))).toBeUndefined();
});
it("checks lossless dimensions, extended canvas consistency and duplicate images", () => {
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(1 | (2 << 14), 1);
  const leaf = chunk("VP8L", lossless);
  expect(webpPreviewSize(riff(leaf))).toEqual({ width: 2, height: 3 });
  const canvas = Buffer.alloc(10);
  canvas[4] = 1;
  canvas[7] = 2;
  expect(webpPreviewSize(riff(chunk("VP8X", canvas), leaf))).toEqual({
    width: 2,
    height: 3,
  });
  canvas[4] = 2;
  expect(webpPreviewSize(riff(chunk("VP8X", canvas), leaf))).toBeUndefined();
  expect(webpPreviewSize(riff(leaf, leaf))).toBeUndefined();
  lossless.writeUInt32LE(8191 | (8191 << 14), 1);
  expect(webpPreviewSize(riff(chunk("VP8L", lossless)))).toBeUndefined();
});
