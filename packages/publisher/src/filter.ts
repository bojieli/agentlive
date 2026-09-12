interface TrieNode {
  children: Map<string, TrieNode>;
  terminal: boolean;
}
const node = (): TrieNode => ({ children: new Map(), terminal: false });

/** Exact known-secret redaction across arbitrary text delta boundaries. */
export class StreamingRedactor {
  private pending = "";
  private closed = false;
  private readonly root = node();
  constructor(
    secrets: readonly string[],
    private readonly replacement = "[REDACTED]",
  ) {
    const unique = [...new Set(secrets)];
    if (
      unique.length > 1024 ||
      unique.some((secret) => !secret.length || secret.length > 4096) ||
      unique.reduce((size, secret) => size + secret.length, 0) > 65536
    )
      throw new RangeError("Invalid secret dictionary");
    for (const secret of unique) {
      let current = this.root;
      for (let i = 0; i < secret.length; i++) {
        const char = secret[i]!;
        let next = current.children.get(char);
        if (!next) {
          next = node();
          current.children.set(char, next);
        }
        current = next;
      }
      current.terminal = true;
    }
  }
  push(text: string): string {
    if (this.closed) throw new Error("Redactor is closed");
    this.pending += text;
    return this.drain(false);
  }
  finish(): string {
    this.closed = true;
    return this.drain(true);
  }
  private drain(final: boolean): string {
    const output: string[] = [];
    let offset = 0;
    let literalStart = 0;
    while (offset < this.pending.length) {
      let current = this.root;
      let scan = offset;
      let matchedEnd = -1;
      while (scan < this.pending.length) {
        const next = current.children.get(this.pending[scan]!);
        if (!next) break;
        current = next;
        scan++;
        if (current.terminal) matchedEnd = scan;
      }
      if (!final && scan === this.pending.length && current.children.size > 0)
        break;
      if (matchedEnd !== -1) {
        output.push(this.pending.slice(literalStart, offset), this.replacement);
        offset = matchedEnd;
        literalStart = offset;
      } else offset++;
    }
    output.push(this.pending.slice(literalStart, offset));
    this.pending = this.pending.slice(offset);
    return output.join("");
  }
}

interface ByteNode {
  children: Map<number, ByteNode>;
  terminal: boolean;
}
const byteNode = (): ByteNode => ({ children: new Map(), terminal: false });
const EMPTY_BYTES = Buffer.alloc(0);

/**
 * Exact known-secret redaction over raw bytes, for content that is not valid
 * UTF-8 text. Each secret is matched as its literal UTF-8 encoding, so a secret
 * embedded in a binary container is still replaced. Every byte that is not part
 * of a match is preserved exactly, and matches spanning a chunk boundary are
 * held over like `StreamingRedactor` does for text. The replacement is shorter
 * than most secrets, so a container whose bytes are replaced can become
 * structurally malformed; that is preferred to serving the secret.
 *
 * Bytes that cannot begin any secret are rejected by a 256-entry table, so
 * content without secrets costs one table lookup per byte and no allocation.
 */
export class StreamingByteRedactor {
  private pending: Buffer = EMPTY_BYTES;
  private closed = false;
  private readonly root = byteNode();
  private readonly starts = new Uint8Array(256);
  private readonly replacement: Buffer;
  /** Longest secret in bytes; bounds both the held-over tail and each walk. */
  private readonly longest: number;
  constructor(secrets: readonly string[], replacement = "[REDACTED]") {
    this.replacement = Buffer.from(replacement, "utf8");
    const unique = [...new Set(secrets)].map((secret) =>
      Buffer.from(secret, "utf8"),
    );
    if (
      unique.length > 1024 ||
      unique.some((secret) => !secret.length || secret.length > 16384) ||
      unique.reduce((size, secret) => size + secret.length, 0) > 262144
    )
      throw new RangeError("Invalid secret dictionary");
    let longest = 1;
    for (const secret of unique) {
      longest = Math.max(longest, secret.length);
      this.starts[secret[0]!] = 1;
      let current = this.root;
      for (const byte of secret) {
        let next = current.children.get(byte);
        if (!next) {
          next = byteNode();
          current.children.set(byte, next);
        }
        current = next;
      }
      current.terminal = true;
    }
    this.longest = longest;
  }
  push(chunk: Uint8Array): Buffer {
    if (this.closed) throw new Error("Redactor is closed");
    return this.drain(chunk, false);
  }
  finish(): Buffer {
    this.closed = true;
    return this.drain(EMPTY_BYTES, true);
  }
  private drain(chunk: Uint8Array, final: boolean): Buffer {
    const buffer = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // Any match starting before this offset is fully contained in the buffer.
    const limit = final ? buffer.length : buffer.length - (this.longest - 1);
    const output: Buffer[] = [];
    const starts = this.starts;
    const length = buffer.length;
    let offset = 0;
    let literalStart = 0;
    while (offset < limit) {
      if (starts[buffer[offset]!] === 0) {
        offset++;
        continue;
      }
      let current = this.root;
      let scan = offset;
      let matchedEnd = -1;
      while (scan < length) {
        const next = current.children.get(buffer[scan]!);
        if (!next) break;
        current = next;
        scan++;
        if (current.terminal) matchedEnd = scan;
      }
      if (matchedEnd !== -1) {
        output.push(buffer.subarray(literalStart, offset), this.replacement);
        offset = matchedEnd;
        literalStart = offset;
      } else offset++;
    }
    output.push(buffer.subarray(literalStart, offset));
    this.pending = final ? EMPTY_BYTES : Buffer.from(buffer.subarray(offset));
    return Buffer.concat(output);
  }
}
