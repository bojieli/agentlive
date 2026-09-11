import { operationSignal } from "./operation-signal.js";
import {
  ActivityIndex,
  PagedReducer,
  tracePairedSnapshot,
} from "@agentlive/playback";
import {
  attachmentSchema,
  canonicalJson,
  ProtocolError,
  snapshotDescriptorSchema,
  type TextReference,
} from "@agentlive/protocol";
import { MemoryContentStore } from "./memory-content.js";
import {
  browserPresentation,
  type BrowserCheckpoint,
  type SnapshotBlobLoader,
} from "./content-store.js";
import type { BrowserView, CacheBinding } from "./history-cache.js";
import type { PagedContentStore } from "./paged-state.js";
import type { Attachment } from "./attachments.js";
import {
  changeExpansion,
  changeTextPage,
  expansionKey,
  textPosition,
  type TextPageChoice,
  type TextPosition,
} from "./inspection-choices.js";
import { retainSeekCheckpoint } from "./checkpoint-catalog.js";

/** Paired checkpoint and inspection metadata scoped to a single in-memory visit. */
export class MemoryPagedStore
  extends MemoryContentStore
  implements PagedContentStore
{
  private head: BrowserCheckpoint | null = null;
  private traceReferences: TextReference[] = [];
  private traceReferenceIds = new Map<string, number>();
  private tracedRoots = new Map<string, Uint32Array>();
  private catalog: BrowserCheckpoint[] = [];
  private pins = new Map<symbol, BrowserCheckpoint>();
  private activeWork = 0;
  private maintenance: Promise<void> | undefined;
  private lastCollectionBytes = 0;
  private lastCollectionEntries = 0;
  private completedWork = 0;
  private readonly collectionBytes: number;
  private sweeping = false;
  private view: BrowserView | undefined;
  private attachment: Attachment | undefined;
  private pages: TextPageChoice[] = [];
  private expansions: string[] = [];
  private metaTail: Promise<void> = Promise.resolve();
  private metaPending = 0;
  private metaClosed: Promise<void> | undefined;
  private readonly metaStop = new AbortController();
  private readonly binding: CacheBinding;
  constructor(
    binding: CacheBinding,
    options: {
      maxBytes?: number;
      maxEntries?: number;
      loader?: SnapshotBlobLoader;
      collectionBytes?: number;
    } = {},
  ) {
    super(options.maxBytes, options.maxEntries, options.loader);
    this.binding = { ...binding };
    this.collectionBytes = options.collectionBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.collectionBytes) || this.collectionBytes < 1)
      throw new RangeError("Invalid collection interval");
  }
  private metadata<T>(
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<T> {
    if (this.metaClosed)
      return Promise.reject(new Error("Memory checkpoint store is closing"));
    if (this.metaPending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Memory checkpoint queue is full"),
      );
    const deadline = operationSignal(
      [this.metaStop.signal, ...(parent ? [parent] : [])],
      10000,
    );
    const signal = deadline.signal;
    this.metaPending++;
    const task = this.metaTail
      .then(() => {
        signal.throwIfAborted();
        return work(signal);
      })
      .finally(() => {
        deadline.dispose();
        this.metaPending--;
      });
    this.metaTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private checkpoint(value: BrowserCheckpoint): BrowserCheckpoint {
    const next = snapshotDescriptorSchema.parse(value);
    if (next.format !== "agentlive.paged-state" || !next.activity)
      throw new ProtocolError(
        "precondition_failed",
        "Memory checkpoints require paired activity roots",
      );
    return { ...next, activity: next.activity };
  }
  private async validate(next: BrowserCheckpoint, signal: AbortSignal) {
    const root = await new PagedReducer(this).open(
      next.ref,
      this.binding,
      signal,
    );
    const rows = await new ActivityIndex(this).open(
      next.activity!,
      this.binding,
      signal,
    );
    if (
      root.appliedSeq !== next.serverSeq ||
      root.timelineMs !== next.timelineMs ||
      rows.appliedSeq !== next.serverSeq ||
      rows.gaps !== (root.maps.gaps?.size ?? 0)
    )
      throw new ProtocolError(
        "corrupt_storage",
        "Memory checkpoint boundaries differ",
      );
    signal.throwIfAborted();
  }
  loadCheckpoint(signal?: AbortSignal) {
    return this.metadata(signal, () => structuredClone(this.head));
  }
  async acquireWork(): Promise<() => void> {
    while (this.maintenance) await this.maintenance;
    return this.beginWork();
  }
  /** Called after guarded operations; a running peer postpones this pass. */
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    this.completedWork++;
    if (
      this.activeWork ||
      this.metaClosed ||
      (this.usage.bytes - this.lastCollectionBytes < this.collectionBytes &&
        this.usage.entries - this.lastCollectionEntries <
          Math.max(1, Math.min(2048, Math.floor(this.maxEntries / 10))) &&
        this.completedWork < 256)
    )
      return Promise.resolve();
    const task = this.collectRetained(AbortSignal.timeout(30000))
      .then(() => {
        this.lastCollectionBytes = this.usage.bytes;
        this.lastCollectionEntries = this.usage.entries;
        this.completedWork = 0;
      })
      .catch((error) => {
        // Lazy reads may import another blob during tracing. Retry at the next
        // completed operation; never undo an already published receipt batch.
        if (error instanceof ProtocolError && error.code === "retry_later")
          return;
        throw error;
      });
    this.maintenance = task.finally(() => {
      this.maintenance = undefined;
    });
    return this.maintenance;
  }
  /** Hold from before constructing roots until publishing or pinning the result. */
  beginWork(): () => void {
    if (this.metaClosed) throw new Error("Memory checkpoint store is closing");
    if (this.sweeping || this.activeWork >= 16)
      throw new ProtocolError("retry_later", "Memory root work is unavailable");
    this.activeWork++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeWork--;
      }
    };
  }
  /** Keep a frozen presentation alive independently of catalog compaction. */
  pinCheckpoint(input: BrowserCheckpoint, signal: AbortSignal) {
    const checkpoint = this.checkpoint(input);
    return this.metadata(signal, async (active) => {
      if (this.pins.size >= 128)
        throw new ProtocolError(
          "retry_later",
          "Memory presentation pin limit exceeded",
        );
      await this.validate(checkpoint, active);
      const token = Symbol("presentation");
      this.pins.set(token, checkpoint);
      return token;
    });
  }
  releasePin(token: symbol, signal: AbortSignal) {
    return this.metadata(signal, () => {
      this.pins.delete(token);
    });
  }
  /** All root construction must use beginWork; existing readers must own a pin. */
  collectRetained(signal: AbortSignal) {
    return this.metadata(signal, async (active) => {
      if (this.activeWork)
        throw new ProtocolError(
          "retry_later",
          "Memory roots are under construction",
        );
      this.sweeping = true;
      try {
        // Seek landmarks are reconstructible from history. Thin them under
        // storage pressure, while independently retaining the head and every
        // presentation pin. Publish the smaller catalog only after a safe sweep.
        const pressure =
          this.usage.bytes >= this.maxBytes * 0.6 ||
          this.usage.entries >= this.maxEntries * 0.6;
        const catalog = pressure
          ? this.catalog.filter(
              (_, index) =>
                index % 2 === 0 || index === this.catalog.length - 1,
            )
          : this.catalog;
        const roots = new Map<string, BrowserCheckpoint>();
        for (const root of [
          ...(this.head ? [this.head] : []),
          ...catalog,
          ...this.pins.values(),
        ])
          roots.set(canonicalJson(root), root);
        // Historical roots share most immutable metadata. Reuse bounded decoded
        // ranges within this frozen scan without caching validation decisions.
        const ranges = new Map<string, string>();
        let rangeBytes = 0;
        const content = {
          put: this.put.bind(this),
          append: this.append.bind(this),
          read: async (
            ref: Parameters<MemoryPagedStore["read"]>[0],
            offset: number,
            length: number,
            signal?: AbortSignal,
          ) => {
            signal?.throwIfAborted();
            const key = canonicalJson([ref, offset, length]);
            const cached = ranges.get(key);
            if (cached !== undefined) return cached;
            const text = await this.read(ref, offset, length, signal);
            const bytes = 2 * (text.length + key.length);
            if (bytes <= 4 * 1024 * 1024) {
              while (
                ranges.size &&
                (rangeBytes + bytes > 4 * 1024 * 1024 || ranges.size >= 4096)
              ) {
                const [oldKey, oldText] = ranges.entries().next().value!;
                rangeBytes -= 2 * (oldKey.length + oldText.length);
                ranges.delete(oldKey);
              }
              ranges.set(key, text);
              rangeBytes += bytes;
            }
            return text;
          },
        };
        const result = await super.collect(async (mark) => {
          for (const key of this.tracedRoots.keys())
            if (!roots.has(key)) this.tracedRoots.delete(key);
          if (this.traceReferences.length >= 60000) {
            // Reclaim IDs belonging only to retired roots. Preserve validated
            // live closures instead of forcing a full multi-root retrace at the
            // pool boundary. Both old and new pools are bounded to 65,536 IDs.
            const references: TextReference[] = [];
            const remap = new Int32Array(this.traceReferences.length).fill(-1);
            for (const [key, old] of this.tracedRoots) {
              const compact = new Uint32Array(2048);
              for (let word = 0; word < old.length; word++) {
                let bits = old[word]!;
                while (bits) {
                  const bit = 31 - Math.clz32(bits & -bits);
                  const id = word * 32 + bit;
                  if (remap[id] === -1) {
                    remap[id] = references.length;
                    references.push(this.traceReferences[id]!);
                  }
                  const next = remap[id]!;
                  compact[next >>> 5]! |= 1 << (next & 31);
                  bits = (bits & (bits - 1)) >>> 0;
                }
              }
              this.tracedRoots.set(key, compact);
            }
            this.traceReferences = references;
            this.traceReferenceIds.clear();
            for (const [id, ref] of references.entries())
              this.traceReferenceIds.set(canonicalJson(ref), id);
          }
          const cachedUnion = new Uint32Array(2048);
          const untraced = new Map<string, BrowserCheckpoint>();
          for (const [key, root] of roots) {
            const cached = this.tracedRoots.get(key);
            if (cached) {
              for (let word = 0; word < cached.length; word++)
                cachedUnion[word]! |= cached[word]!;
            } else untraced.set(key, root);
          }
          for (let word = 0; word < cachedUnion.length; word++) {
            let bits = cachedUnion[word]!;
            while (bits) {
              const bit = 31 - Math.clz32(bits & -bits);
              await mark(this.traceReferences[word * 32 + bit]!);
              bits = (bits & (bits - 1)) >>> 0;
            }
          }
          for (const [key, root] of untraced) {
            const closure = new Uint32Array(2048);
            let complete = true;
            await tracePairedSnapshot(
              content,
              root,
              this.binding,
              async (ref) => {
                await mark(ref);
                const identity = canonicalJson(ref);
                let id = this.traceReferenceIds.get(identity);
                if (id === undefined) {
                  if (this.traceReferences.length >= 65536) {
                    complete = false;
                    return;
                  }
                  id = this.traceReferences.length;
                  this.traceReferences.push({ ...ref });
                  this.traceReferenceIds.set(identity, id);
                }
                closure[id >>> 5]! |= 1 << (id & 31);
              },
              active,
            );
            // Only a complete typed validation can authorize reuse. Codec
            // dependencies are still verified on every collection pass.
            if (complete) this.tracedRoots.set(key, closure);
          }
        }, active);
        this.catalog = catalog;
        return result;
      } finally {
        this.sweeping = false;
      }
    });
  }
  loadCheckpointBefore(time: number, through: number, signal: AbortSignal) {
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      !Number.isSafeInteger(through) ||
      through < 0
    )
      return Promise.reject(new RangeError("Invalid seek checkpoint boundary"));
    return this.metadata(signal, () =>
      structuredClone(
        this.catalog.findLast(
          (entry) => entry.serverSeq <= through && entry.timelineMs <= time,
        ) ?? null,
      ),
    );
  }
  publishCheckpoint(
    expected: BrowserCheckpoint | null,
    input: BrowserCheckpoint,
    signal?: AbortSignal,
  ) {
    expected = expected === null ? null : this.checkpoint(expected);
    const next = this.checkpoint(input);
    return this.metadata(signal, async (active) => {
      await this.validate(next, active);
      if (canonicalJson(this.head) === canonicalJson(next))
        return structuredClone(next);
      if (canonicalJson(this.head) !== canonicalJson(expected))
        throw new ProtocolError(
          "event_conflict",
          "Memory checkpoint changed in another writer",
        );
      if (
        this.head &&
        (next.serverSeq <= this.head.serverSeq ||
          next.timelineMs < this.head.timelineMs)
      )
        throw new ProtocolError(
          "event_conflict",
          "Memory checkpoint cannot move backward",
        );
      this.catalog = retainSeekCheckpoint(this.catalog, next);
      this.head = next;
      return structuredClone(next);
    });
  }
  saveSeekCheckpoint(input: BrowserCheckpoint, signal: AbortSignal) {
    const next = this.checkpoint(input);
    return this.metadata(signal, async (active) => {
      await this.validate(next, active);
      if (
        !this.head ||
        next.serverSeq > this.head.serverSeq ||
        next.timelineMs > this.head.timelineMs
      )
        throw new ProtocolError(
          "precondition_failed",
          "Seek checkpoint exceeds receipt",
        );
      const existing =
        next.serverSeq === this.head.serverSeq
          ? this.head
          : this.catalog.find((entry) => entry.serverSeq === next.serverSeq);
      if (existing && canonicalJson(existing) !== canonicalJson(next))
        throw new ProtocolError(
          "event_conflict",
          "Seek checkpoint differs from saved prefix",
        );
      const catalog = retainSeekCheckpoint(this.catalog, next, true);
      if (
        catalog.some(
          (entry, index) =>
            index > 0 && entry.timelineMs < catalog[index - 1]!.timelineMs,
        )
      )
        throw new ProtocolError(
          "event_conflict",
          "Seek checkpoint time order differs",
        );
      this.catalog = catalog;
    });
  }
  loadView(signal: AbortSignal) {
    return this.metadata(signal, () => structuredClone(this.view));
  }
  saveView(input: BrowserView, signal: AbortSignal) {
    const view = browserPresentation(input);
    return this.metadata(signal, () => {
      if (
        view.serverSeq > (this.head?.serverSeq ?? 0) ||
        view.timelineMs > (this.head?.timelineMs ?? 0)
      )
        throw new ProtocolError(
          "precondition_failed",
          "Playback preference exceeds receipt",
        );
      this.view = view;
    });
  }
  loadAttachmentChoice(signal: AbortSignal) {
    return this.metadata(signal, () => structuredClone(this.attachment));
  }
  setAttachmentChoice(input: Attachment | undefined, signal: AbortSignal) {
    const value =
      input === undefined ? undefined : attachmentSchema.parse(input);
    return this.metadata(signal, () => {
      this.attachment = value;
    });
  }
  loadTextPages(signal: AbortSignal) {
    return this.metadata(signal, () => structuredClone(this.pages));
  }
  setTextPage(key: string, page: TextPosition, signal: AbortSignal) {
    key = expansionKey(key);
    page = textPosition(page);
    return this.metadata(signal, () => {
      this.pages = changeTextPage(this.pages, key, page);
    });
  }
  loadExpansions(signal: AbortSignal) {
    return this.metadata(signal, () => [...this.expansions]);
  }
  setExpansion(key: string, expanded: boolean, signal: AbortSignal) {
    key = expansionKey(key);
    return this.metadata(signal, () => {
      this.expansions = changeExpansion(this.expansions, key, expanded);
    });
  }
  override close() {
    if (!this.metaClosed) {
      this.metaStop.abort(new Error("Memory checkpoint store is closing"));
      this.metaClosed = Promise.all([this.metaTail, super.close()]).then(() => {
        this.head = null;
        this.catalog = [];
        this.pins.clear();
        this.tracedRoots.clear();
        this.traceReferences = [];
        this.traceReferenceIds.clear();
        this.view = undefined;
        this.attachment = undefined;
        this.pages = [];
        this.expansions = [];
      });
    }
    return this.metaClosed;
  }
}
