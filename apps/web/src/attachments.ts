import { attachmentSchema, type EventContent } from "@agentlive/protocol";
import { accountFetch } from "./account-transport.js";
export type Attachment = Extract<
  EventContent,
  { kind: "attachment.available" }
>["payload"]["attachment"];
export async function loadAttachment(
  attachment: Attachment,
  streamId: string,
  credential: string,
  parent: AbortSignal,
  origin = location.origin,
  fetcher: typeof fetch = accountFetch,
): Promise<Uint8Array<ArrayBuffer>> {
  attachmentSchema.parse(attachment);
  if (attachment.byteSize > 25 * 1024 * 1024)
    throw new Error("Attachment exceeds the 25 MiB browser limit");
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
  signal.throwIfAborted();
  const response = await fetcher(
    new URL(
      `/api/v1/streams/${encodeURIComponent(streamId)}/attachments/${attachment.hash}`,
      origin,
    ),
    {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    },
  );
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Attachment is unavailable or access was denied");
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes: Uint8Array<ArrayBuffer>;
  let offset = 0;
  try {
    signal.throwIfAborted();
    bytes = new Uint8Array(attachment.byteSize);
    for (;;) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      if (offset + item.value.length > bytes.length)
        throw new Error("Attachment exceeds its announced size");
      bytes.set(item.value, offset);
      offset += item.value.length;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (offset !== bytes.length) throw new Error("Attachment is truncated");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  signal.throwIfAborted();
  if (hash !== attachment.hash)
    throw new Error("Attachment integrity check failed");
  return bytes;
}

/** Preflight allocation/animation limits; the browser remains responsible for PNG decoding and CRC checks.
 * PNG chunk layout: https://www.w3.org/TR/png-3/#5Chunk-layout
 */
export function pngPreviewSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (
    bytes.length < 45 ||
    bytes.length > 8 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    width = 0,
    height = 0,
    hasData = false;
  let chunks = 0;
  while (offset + 12 <= bytes.length) {
    if (++chunks > 4096) return;
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) return;
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        width * height > 16 * 1024 * 1024
      )
        return;
    } else if (type === "IHDR") return;
    // Do not send animation or compressed ancillary metadata to a preview decoder.
    if (["acTL", "fcTL", "fdAT", "iCCP", "zTXt", "iTXt"].includes(type)) return;
    if (type === "IDAT") hasData = true;
    if (type === "IEND")
      return length === 0 && end === bytes.length && hasData
        ? { width, height }
        : undefined;
    offset = end;
  }
}
export function textPreview(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (
    bytes.length > 1024 * 1024 ||
    !(
      type.startsWith("text/") ||
      ["application/json", "application/xml", "image/svg+xml"].includes(type)
    )
  )
    return;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return;
  }
}

/** Bounded JPEG marker preflight; entropy decoding remains the browser's responsibility. */
export function jpegPreviewSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (
    bytes.length < 16 ||
    bytes.length > 8 * 1024 * 1024 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  )
    return;
  let offset = 2,
    markers = 0,
    width = 0,
    height = 0,
    scans = 0,
    entropy = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
      if (offset === bytes.length) return;
    } else if (bytes[offset] !== 0xff) return;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return;
    const marker = bytes[offset++]!;
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)))
      continue;
    entropy = false;
    if (++markers > 4096) return;
    if (marker === 0xd9)
      return offset === bytes.length && width && scans
        ? { width, height }
        : undefined;
    if (
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0xdc ||
      marker === 1
    )
      return;
    if (offset + 2 > bytes.length) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (
        ![0xc0, 0xc2].includes(marker) ||
        width ||
        length < 11 ||
        bytes[offset + 2] !== 8
      )
        return;
      height = view.getUint16(offset + 3);
      width = view.getUint16(offset + 5);
      const components = bytes[offset + 7]!;
      if (
        ![1, 3, 4].includes(components) ||
        length !== 8 + 3 * components ||
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        width * height > 16 * 1024 * 1024
      )
        return;
    }
    if (marker === 0xda) {
      if (
        !width ||
        ++scans > 256 ||
        length < 8 ||
        length !== 6 + 2 * bytes[offset + 2]!
      )
        return;
      entropy = true;
    }
    offset += length;
  }
}
/** Static WebP RIFF preflight: VP8/VP8L dimensions must agree with an optional VP8X canvas. */
export function webpPreviewSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 20 || bytes.length > 8 * 1024 * 1024) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WEBP" ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return;
  const valid = (width: number, height: number) =>
    width > 0 &&
    height > 0 &&
    width <= 8192 &&
    height <= 8192 &&
    width * height <= 16 * 1024 * 1024;
  const uint24 = (offset: number) =>
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  let offset = 12,
    chunks = 0;
  let canvas: { width: number; height: number } | undefined;
  let image: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    if (++chunks > 4096) return;
    const type = tag(offset),
      size = view.getUint32(offset + 4, true),
      start = offset + 8,
      end = start + size;
    if (end + (size & 1) > bytes.length) return;
    if (type === "ANIM" || type === "ANMF") return;
    if (type === "VP8X") {
      if (
        offset !== 12 ||
        size !== 10 ||
        canvas ||
        bytes[start]! & 0xc3 ||
        bytes[start + 1] ||
        bytes[start + 2] ||
        bytes[start + 3]
      )
        return;
      canvas = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
      if (!valid(canvas.width, canvas.height)) return;
    } else if (type === "VP8 ") {
      if (
        image ||
        size < 10 ||
        bytes[start]! & 1 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 1 ||
        bytes[start + 5] !== 0x2a
      )
        return;
      image = {
        width: view.getUint16(start + 6, true) & 0x3fff,
        height: view.getUint16(start + 8, true) & 0x3fff,
      };
    } else if (type === "VP8L") {
      if (
        image ||
        size < 5 ||
        bytes[start] !== 0x2f ||
        bytes[start + 4]! & 0xe0
      )
        return;
      const bits = view.getUint32(start + 1, true);
      image = {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      image &&
      (!valid(image.width, image.height) ||
        (canvas &&
          (canvas.width !== image.width || canvas.height !== image.height)))
    )
      return;
    offset = end + (size & 1);
  }
  return offset === bytes.length ? image : undefined;
}
export function rasterPreview(bytes: Uint8Array, mediaType: string) {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  const dimensions =
    type === "image/png"
      ? pngPreviewSize(bytes)
      : type === "image/jpeg"
        ? jpegPreviewSize(bytes)
        : type === "image/webp"
          ? webpPreviewSize(bytes)
          : undefined;
  return dimensions ? { ...dimensions, mediaType: type } : undefined;
}
