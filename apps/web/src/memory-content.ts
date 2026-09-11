import { operationSignal } from "./operation-signal.js";
import {
  canonicalJson,
  ProtocolError,
  TextContent,
  validateTextReference,
  type TextReference,
} from "@agentlive/protocol";
import type { SnapshotBlobLoader } from "./content-store.js";

const encoder = new TextEncoder();
const ascii = /^[\x00-\x7f]*$/;
/** Hold blob bytes as a one-byte "binary" string: one UTF-16 unit per byte,
 * each below 256. V8 stores these inline in the heap, avoiding a typed-array
 * wrapper, ArrayBuffer and external backing store per small blob (measured at
 * about 311 versus 127 bytes of overhead per entry on Node 26.8.1). */
const utf8 = new TextDecoder();
function pack(bytes: Uint8Array): string {
  // ASCII bytes decode to the identical one-byte string natively. Any byte
  // at or above 0x80 yields a non-ASCII character (or U+FFFD) and falls back.
  const decoded = utf8.decode(bytes);
  if (decoded.length === bytes.length && ascii.test(decoded)) return decoded;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    parts.push(
      String.fromCharCode.apply(
        null,
        bytes.subarray(offset, offset + 8192) as unknown as number[],
      ),
    );
  return parts.join("");
}
/** Fresh bytes for every reader; stored content is never exposed mutably. */
function unpack(text: string): Uint8Array<ArrayBuffer> {
  if (ascii.test(text)) return encoder.encode(text);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++)
    bytes[index] = text.charCodeAt(index);
  return bytes;
}
/** Visit-local immutable codec storage. No filesystem or browser persistence. */
export class MemoryContentStore {
  private readonly blobs = new Map<string, string>();
  private bytes = 0;
  /** Blobs installed since the last successful sweep. Content is immutable and
   * content-addressed, so a surviving (older) blob can only reference blobs that
   * were already present when it was written; each sweep retained the complete
   * closure of every blob it kept. Hence older blobs never depend on younger ones. */
  private readonly young = new Set<string>();
  private youngBytes = 0;
  private readonly nodes = new Map<string, unknown>();
  /** Bounded memo of validated immutable index nodes read from this store (see
   * SnapshotContent.decodedNodes). Every successful sweep and close clears it,
   * so a node is never served after its blob could have been reclaimed. */
  readonly decodedNodes = {
    get: (key: string) => this.nodes.get(key),
    set: (key: string, value: unknown) => {
      if (this.closing) return;
      if (this.nodes.size >= 1024)
        this.nodes.delete(this.nodes.keys().next().value!);
      this.nodes.set(key, value);
    },
  };
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private collecting = false;
  private readonly stop = new AbortController();
  private closing: Promise<void> | undefined;
  /** The byte quota bounds retained payload. The entry quota bounds per-blob
   * bookkeeping (about 150 bytes each with one-byte string storage; see pack),
   * so 262,144 entries add at most about 40 MB beyond the payload. */
  constructor(
    protected readonly maxBytes = 64 * 1024 * 1024,
    protected readonly maxEntries = 262144,
    private readonly loader?: SnapshotBlobLoader,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 262144
    )
      throw new RangeError("Invalid memory content quota");
  }
  get usage() {
    return { bytes: this.bytes, entries: this.blobs.size };
  }
  /** Usage installed since the last successful sweep. */
  protected get youngUsage() {
    return { bytes: this.youngBytes, entries: this.young.size };
  }
  /** Present and retained by an earlier successful sweep, together with its
   * complete dependency closure (see `young`). */
  protected survivor(hash: string) {
    return this.blobs.has(hash) && !this.young.has(hash);
  }
  private async wait<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return work();
        })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async hash(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    const digest = await this.wait(
      () => crypto.subtle.digest("SHA-256", bytes),
      signal,
    );
    signal.throwIfAborted();
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  private run<T>(
    parent: AbortSignal | undefined,
    operation: (
      codec: TextContent,
      load: SnapshotBlobLoader,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Memory content store is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Memory content queue is full"),
      );
    const deadline = operationSignal(
      [this.stop.signal, ...(parent ? [parent] : [])],
      10000,
    );
    const signal = deadline.signal;
    this.pending++;
    const task = this.tail
      .then(async () => {
        signal.throwIfAborted();
        // An entire codec operation commits together; quota, corrupt input and
        // cancellation cannot retain its partial pages or downloaded dependencies.
        const staged = new Map<string, string>();
        let stagedBytes = 0;
        const install = (
          ref: TextReference,
          bytes: Uint8Array<ArrayBuffer>,
        ) => {
          signal.throwIfAborted();
          if (this.blobs.has(ref.hash) || staged.has(ref.hash)) return;
          if (
            this.bytes + stagedBytes + bytes.length > this.maxBytes ||
            this.blobs.size + staged.size >= this.maxEntries
          )
            throw new ProtocolError(
              "retry_later",
              "Memory content quota exceeded",
            );
          staged.set(ref.hash, pack(bytes));
          stagedBytes += bytes.length;
        };
        const load: SnapshotBlobLoader = async (input, active) => {
          const ref = { ...input };
          validateTextReference(ref, 67108864);
          active.throwIfAborted();
          const stored = staged.get(ref.hash) ?? this.blobs.get(ref.hash);
          if (stored !== undefined) {
            if (stored.length !== ref.byteSize)
              throw new ProtocolError(
                "corrupt_storage",
                "Missing memory content blob",
              );
            return unpack(stored);
          }
          let bytes: Uint8Array<ArrayBuffer> | undefined;
          if (this.loader) {
            const remote = await this.wait(
              () => this.loader!({ ...ref }, active),
              active,
            );
            active.throwIfAborted();
            if (
              !(remote instanceof Uint8Array) ||
              remote.length !== ref.byteSize
            )
              throw new ProtocolError(
                "corrupt_storage",
                "Invalid memory content blob",
              );
            bytes = new Uint8Array(remote);
            if ((await this.hash(bytes, active)) !== ref.hash)
              throw new ProtocolError(
                "corrupt_storage",
                "Memory content hash differs",
              );
            install(ref, bytes);
          }
          if (!bytes || bytes.length !== ref.byteSize)
            throw new ProtocolError(
              "corrupt_storage",
              "Missing memory content blob",
            );
          return new Uint8Array(bytes);
        };
        const codec = new TextContent({
          load: (ref, active) => load(ref, active ?? signal),
          save: async (value, units, active = signal) => {
            active.throwIfAborted();
            const bytes = encoder.encode(canonicalJson(value));
            if (bytes.length > 1048576)
              throw new RangeError("Content blob exceeds limit");
            const ref = {
              hash: await this.hash(bytes, active),
              byteSize: bytes.length,
              units,
            };
            validateTextReference(ref, 67108864);
            install(ref, bytes);
            return ref;
          },
          flush: async (active = signal) => {
            active.throwIfAborted();
          },
        });
        const result = await operation(codec, load, signal);
        signal.throwIfAborted();
        if (staged.size) this.revision++;
        for (const [hash, bytes] of staged) {
          this.blobs.set(hash, bytes);
          this.young.add(hash);
        }
        this.bytes += stagedBytes;
        this.youngBytes += stagedBytes;
        return result;
      })
      .finally(() => {
        deadline.dispose();
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  put(source: string | AsyncIterable<string>, signal?: AbortSignal) {
    return this.run(signal, async (codec, _load, active) => {
      const ref = await codec.put(source, active);
      this.revision++;
      return ref;
    });
  }
  append(
    ref: TextReference,
    source: string | AsyncIterable<string>,
    signal?: AbortSignal,
  ) {
    ref = { ...ref };
    return this.run(signal, async (codec, _load, active) => {
      const next = await codec.append(ref, source, active);
      this.revision++;
      return next;
    });
  }
  read(
    ref: TextReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    ref = { ...ref };
    return this.run(signal, (codec, _load, active) =>
      codec.read(ref, offset, length, active),
    );
  }
  trace(ref: TextReference, signal?: AbortSignal) {
    ref = { ...ref };
    return this.run(signal, (codec, _load, active) => codec.trace(ref, active));
  }
  readBlob(ref: TextReference, signal?: AbortSignal) {
    ref = { ...ref };
    return this.run(signal, (_codec, load, active) => load(ref, active));
  }
  /** Caller freezes its complete root/pin set until this operation completes.
   * Mark codec manifests emitted by typed reducer/activity reachability walks.
   * Any intervening write (including deduplication) invalidates the sweep.
   *
   * A minor collection considers only blobs installed since the last successful
   * sweep. Surviving blobs are kept without re-verification, so the walker need
   * not descend into them; it must still mark every young blob reachable from
   * its roots. A major collection verifies and considers every blob.
   */
  async collect(
    traceRoots: (
      /** Resolves with the usage this call newly marked (zero if repeated). */
      mark: (ref: TextReference) => Promise<{ bytes: number; entries: number }>,
      signal: AbortSignal,
    ) => Promise<void>,
    parent: AbortSignal,
    options: { minor?: boolean } = {},
  ) {
    const minor = options.minor === true;
    if (this.collecting)
      throw new ProtocolError(
        "retry_later",
        "Memory collection already running",
      );
    this.collecting = true;
    const signal = AbortSignal.any([
      parent,
      this.stop.signal,
      AbortSignal.timeout(30000),
    ]);
    try {
      const revision = await this.run(signal, async () => this.revision);
      const marked = new Set<string>();
      // Validated descriptor packed as one exact number: byteSize ≤ 2^20 and
      // units ≤ 2^26, so byteSize·2^27 + units stays below 2^47.
      const manifests = new Map<string, number>();
      let accepting = true;
      let pendingMarks = 0;
      let failed: unknown;
      const none = { bytes: 0, entries: 0 };
      const markOnce = async (input: TextReference) => {
        signal.throwIfAborted();
        if (!accepting) throw new Error("Memory collection marking is closed");
        const ref = { ...input };
        validateTextReference(ref, 67108864);
        const descriptor = ref.byteSize * 134217728 + ref.units;
        const previous = manifests.get(ref.hash);
        if (previous !== undefined) {
          if (previous !== descriptor)
            throw new ProtocolError(
              "corrupt_storage",
              "Conflicting memory content references",
            );
          return none;
        }
        if (manifests.size >= this.maxEntries)
          throw new ProtocolError(
            "retry_later",
            "Memory collection mark limit exceeded",
          );
        manifests.set(ref.hash, descriptor);
        if (minor && this.survivor(ref.hash)) {
          if (this.blobs.get(ref.hash)!.length !== ref.byteSize)
            throw new ProtocolError(
              "corrupt_storage",
              "Conflicting memory content references",
            );
          return none;
        }
        const references = await this.trace(ref, signal);
        signal.throwIfAborted();
        const added = { bytes: 0, entries: 0 };
        for (const dependency of references) {
          if (marked.has(dependency.hash)) continue;
          if (marked.size >= this.maxEntries)
            throw new ProtocolError(
              "retry_later",
              "Memory collection mark limit exceeded",
            );
          marked.add(dependency.hash);
          added.bytes += dependency.byteSize;
          added.entries++;
        }
        return added;
      };
      const mark = (input: TextReference) => {
        pendingMarks++;
        const task = markOnce(input);
        void task.then(
          () => {
            pendingMarks--;
          },
          (error) => {
            pendingMarks--;
            failed ??= error;
          },
        );
        return task;
      };
      try {
        await this.wait(() => traceRoots(mark, signal), signal);
      } finally {
        accepting = false;
      }
      if (failed !== undefined) throw failed;
      if (pendingMarks)
        throw new ProtocolError(
          "precondition_failed",
          "Memory collection marks must be awaited",
        );
      return await this.run(signal, async () => {
        if (this.revision !== revision)
          throw new ProtocolError(
            "retry_later",
            "Memory content changed during collection",
          );
        let removedBytes = 0,
          removedEntries = 0;
        for (const hash of minor ? this.young : this.blobs.keys()) {
          if (marked.has(hash)) continue;
          removedBytes += this.blobs.get(hash)!.length;
          removedEntries++;
          this.blobs.delete(hash);
        }
        this.bytes -= removedBytes;
        this.nodes.clear();
        // Every remaining blob now carries its complete marked closure.
        this.young.clear();
        this.youngBytes = 0;
        this.revision++;
        return { removedBytes, removedEntries, ...this.usage };
      });
    } finally {
      this.collecting = false;
    }
  }
  close() {
    if (!this.closing) {
      this.stop.abort(new Error("Memory content store is closing"));
      this.closing = this.tail.then(() => {
        this.blobs.clear();
        this.nodes.clear();
        this.young.clear();
        this.bytes = 0;
        this.youngBytes = 0;
      });
    }
    return this.closing;
  }
}
