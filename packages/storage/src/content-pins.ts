import {
  ProtocolError,
  CONTENT_PAGE_UNITS,
  validateTextReference,
  type TextReference,
} from "@agentlive/protocol";

/** Text roots retain a manifest and its pages; blob roots retain exact bytes only. */
export type ContentPinRoot = Readonly<{
  kind: "text" | "blob";
  ref: Readonly<TextReference>;
}>;

export interface ContentPin {
  /** Replace the retained roots atomically; rejected while a retention barrier is held. */
  update(roots: readonly TextReference[]): void;
  /** Idempotent. A barrier's captured roots remain retained until that barrier ends. */
  release(): void;
}
/** In-process root leases. This is not a durable catalog or a remote-reader lease.
 * A collector must separately exclude content writes and include durable published roots.
 */
export class ContentPins {
  private readonly pins = new Map<symbol, readonly ContentPinRoot[]>();
  private barrier = false;
  constructor(
    private readonly maximumPins = 128,
    private readonly maximumRootsPerPin = 32,
  ) {
    for (const limit of [maximumPins, maximumRootsPerPin])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
        throw new RangeError("Invalid content pin capacity");
  }
  private admit() {
    if (this.barrier)
      throw new ProtocolError(
        "retry_later",
        "Content retention barrier is active",
      );
  }
  private copy(roots: readonly TextReference[], kind: ContentPinRoot["kind"]) {
    if (kind !== "text" && kind !== "blob")
      throw new RangeError("Invalid content pin kind");
    if (!Array.isArray(roots) || roots.length > this.maximumRootsPerPin)
      throw new RangeError("Content pin root limit exceeded");
    const copied = roots.map((root) => {
      validateTextReference(root, 4096 * CONTENT_PAGE_UNITS);
      return { ref: { ...root }, kind };
    });
    return copied;
  }
  pin(
    roots: readonly TextReference[],
    kind: ContentPinRoot["kind"] = "text",
  ): ContentPin {
    this.admit();
    if (this.pins.size >= this.maximumPins)
      throw new ProtocolError("retry_later", "Content pins are at capacity");
    const saved = this.copy(roots, kind),
      id = Symbol();
    this.pins.set(id, saved);
    return {
      update: (roots) => {
        if (!this.pins.has(id))
          throw new ProtocolError(
            "precondition_failed",
            "Content pin is released",
          );
        this.admit();
        const saved = this.copy(roots, kind);
        this.pins.set(id, saved);
      },
      release: () => {
        this.pins.delete(id);
      },
    };
  }
  get size() {
    return this.pins.size;
  }
  /** Hold admission closed for the full caller operation, even if its signal is cancelled.
   * No timeout can release this barrier while accepted work is still running.
   */
  async withBarrier<T>(
    operation: (
      roots: readonly ContentPinRoot[],
      signal?: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.admit();
    this.barrier = true;
    try {
      const roots = new Map<string, ContentPinRoot>();
      const descriptors = new Map<string, Readonly<TextReference>>();
      for (const values of this.pins.values())
        for (const value of values) {
          const previous = descriptors.get(value.ref.hash);
          if (
            previous &&
            (previous.byteSize !== value.ref.byteSize ||
              previous.units !== value.ref.units)
          )
            throw new ProtocolError(
              "corrupt_storage",
              "Conflicting pinned content references",
            );
          descriptors.set(value.ref.hash, value.ref);
          roots.set(`${value.kind}:${value.ref.hash}`, {
            kind: value.kind,
            ref: { ...value.ref },
          });
        }
      const snapshot = Object.freeze(
        [...roots.values()].map((root) =>
          Object.freeze({ kind: root.kind, ref: Object.freeze(root.ref) }),
        ),
      );
      const result = await operation(snapshot, signal);
      signal?.throwIfAborted();
      return result;
    } finally {
      this.barrier = false;
    }
  }
}
