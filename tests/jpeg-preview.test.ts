import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { jpegPreviewSize, rasterPreview } from "../apps/web/src/attachments.js";
it("preflights a real JPEG and rejects corrupt dimensions, framing and mismatched media", async () => {
  const bytes = await readFile(
    new URL("./fixtures/images/pixel.jpg", import.meta.url),
  );
  expect(jpegPreviewSize(bytes)).toEqual({ width: 1, height: 1 });
  expect(rasterPreview(bytes, "image/jpeg")).toEqual({
    width: 1,
    height: 1,
    mediaType: "image/jpeg",
  });
  expect(rasterPreview(bytes, "image/png")).toBeUndefined();
  for (const size of [0, 1, 2, 8, bytes.length - 1])
    expect(jpegPreviewSize(bytes.subarray(0, size))).toBeUndefined();
  expect(
    jpegPreviewSize(Buffer.concat([bytes, Buffer.from([0])])),
  ).toBeUndefined();
  const frame = bytes.indexOf(Buffer.from([255, 192]));
  expect(frame).toBeGreaterThan(0);
  for (const dimensions of [
    [0, 1],
    [9000, 1],
    [8192, 8192],
  ]) {
    const changed = Buffer.from(bytes);
    changed.writeUInt16BE(dimensions[0]!, frame + 5);
    changed.writeUInt16BE(dimensions[1]!, frame + 7);
    expect(jpegPreviewSize(changed)).toBeUndefined();
  }
  const invalid = Buffer.from(bytes);
  invalid.writeUInt16BE(1, frame + 2);
  expect(jpegPreviewSize(invalid)).toBeUndefined();
  expect(jpegPreviewSize(new Uint8Array(8 * 1024 * 1024 + 1))).toBeUndefined();
});

it("accepts bounded progressive scans and rejects unsupported JPEG frame modes and incomplete entropy", () => {
  const frame = [255, 216, 255, 194, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0];
  const scan = [
    255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 42, 255, 0, 43, 255, 208, 44,
  ];
  const bytes = Uint8Array.from([...frame, ...scan, ...scan, 255, 217]);
  expect(jpegPreviewSize(bytes)).toEqual({ width: 3, height: 2 });
  const unsupported = Uint8Array.from(bytes);
  unsupported[3] = 195;
  expect(jpegPreviewSize(unsupported)).toBeUndefined();
  const dnl = Uint8Array.from([
    ...frame,
    ...scan,
    255,
    220,
    0,
    4,
    0,
    2,
    255,
    217,
  ]);
  expect(jpegPreviewSize(dnl)).toBeUndefined();
  expect(
    jpegPreviewSize(Uint8Array.from([...frame, ...scan, 1, 2, 3])),
  ).toBeUndefined();
});
