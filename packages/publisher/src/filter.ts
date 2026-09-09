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
