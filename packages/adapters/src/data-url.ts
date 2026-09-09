const literalUrlByte = /^[A-Za-z0-9;/?:@&=+$,\-_.!~*'()]$/;
/** Bounded RFC 2397 decoding. Text must remain safe for the UTF-8 filtering pipeline. */
export function decodeArtifactDataUrl(url: string, expectedMime = "") {
  const maximum = 32 * 1024 * 1024;
  if (!url.startsWith("data:") || url.length > maximum + 1024) return;
  const comma = url.indexOf(",");
  if (comma < 5 || comma > 1024) return;
  const fields = url.slice(5, comma).split(";");
  const mediaType = (fields.shift() || "text/plain").toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType) || mediaType.length > 128)
    return;
  if (expectedMime && expectedMime.toLowerCase() !== mediaType) return;
  const base64 = fields.at(-1)?.toLowerCase() === "base64";
  if (base64) fields.pop();
  let charset: string | undefined;
  for (const field of fields) {
    const match = /^charset=([a-z0-9-]+)$/i.exec(field);
    if (!match || charset !== undefined) return;
    charset = match[1]!.toLowerCase();
    if (!["utf-8", "us-ascii"].includes(charset)) return;
  }
  const encoded = url.slice(comma + 1);
  if (encoded.length > maximum) return;
  // Decode octets directly: decodeURIComponent rejects valid non-UTF-8 binary bytes.
  const decoded = Buffer.allocUnsafe(encoded.length);
  let size = 0;
  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code === 37) {
      const pair = encoded.slice(i + 1, i + 3);
      if (!/^[a-f0-9]{2}$/i.test(pair)) return;
      decoded[size++] = Number.parseInt(pair, 16);
      i += 2;
    } else {
      // URI characters only; a plus is a literal plus, never a form-encoded space.
      if (!literalUrlByte.test(encoded[i]!)) return;
      decoded[size++] = code;
    }
  }
  let bytes = decoded.subarray(0, size);
  if (base64) {
    const value = bytes.toString("ascii");
    if (
      bytes.some((byte) => byte > 127) ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    )
      return;
    bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return;
  }
  if (bytes.length > 24 * 1024 * 1024) return;
  const text =
    mediaType.startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "application/xml",
      "image/svg+xml",
    ].includes(mediaType);
  if (text) {
    if (charset === "us-ascii" && bytes.some((byte) => byte > 127)) return;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    }
  }
  return { bytes, mediaType, text };
}
