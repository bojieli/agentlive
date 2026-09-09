import { attachmentSchema, type EventContent } from "@agentlive/protocol";
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
  fetcher: typeof fetch = fetch,
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
