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
/** Visit-local immutable codec storage. No filesystem or browser persistence. */
export class MemoryContentStore {
  private readonly blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  private bytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private collecting = false;
  private readonly stop = new AbortController();
  private closing: Promise<void> | undefined;
  constructor(
    protected readonly maxBytes = 64 * 1024 * 1024,
    protected readonly maxEntries = 65536,
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
        const staged = new Map<string, Uint8Array<ArrayBuffer>>();
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
          staged.set(ref.hash, bytes);
          stagedBytes += bytes.length;
        };
        const load: SnapshotBlobLoader = async (input, active) => {
          const ref = { ...input };
          validateTextReference(ref, 67108864);
          active.throwIfAborted();
          let bytes = staged.get(ref.hash) ?? this.blobs.get(ref.hash);
          if (!bytes && this.loader) {
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
        for (const [hash, bytes] of staged) this.blobs.set(hash, bytes);
        this.bytes += stagedBytes;
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
   */
  async collect(
    traceRoots: (
      mark: (ref: TextReference) => Promise<void>,
      signal: AbortSignal,
    ) => Promise<void>,
    parent: AbortSignal,
  ) {
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
      const manifests = new Map<string, TextReference>();
      let accepting = true;
      let pendingMarks = 0;
      let failed: unknown;
      const markOnce = async (input: TextReference) => {
        signal.throwIfAborted();
        if (!accepting) throw new Error("Memory collection marking is closed");
        const ref = { ...input };
        validateTextReference(ref, 67108864);
        const previous = manifests.get(ref.hash);
        if (previous) {
          if (
            previous.byteSize !== ref.byteSize ||
            previous.units !== ref.units
          )
            throw new ProtocolError(
              "corrupt_storage",
              "Conflicting memory content references",
            );
          return;
        }
        if (manifests.size >= this.maxEntries)
          throw new ProtocolError(
            "retry_later",
            "Memory collection mark limit exceeded",
          );
        manifests.set(ref.hash, ref);
        const references = await this.trace(ref, signal);
        signal.throwIfAborted();
        for (const dependency of references) {
          if (marked.size >= this.maxEntries && !marked.has(dependency.hash))
            throw new ProtocolError(
              "retry_later",
              "Memory collection mark limit exceeded",
            );
          marked.add(dependency.hash);
        }
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
        for (const [hash, bytes] of this.blobs) {
          if (marked.has(hash)) continue;
          removedBytes += bytes.length;
          removedEntries++;
          this.blobs.delete(hash);
        }
        this.bytes -= removedBytes;
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
        this.bytes = 0;
      });
    }
    return this.closing;
  }
}
