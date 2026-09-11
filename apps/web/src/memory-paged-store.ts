import { operationSignal } from "./operation-signal.js";
import {
  ActivityIndex,
  PagedReducer,
  tracePairedSnapshot,
} from "@agentlive/playback";
import {
  attachmentSchema,
  canonicalJson,
  parseContentReference,
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
import {
  retainSeekCheckpoint,
  thinSeekCheckpoints,
} from "./checkpoint-catalog.js";

/** Paired checkpoint and inspection metadata scoped to a single in-memory visit. */
export class MemoryPagedStore
  extends MemoryContentStore
  implements PagedContentStore
{
  private head: BrowserCheckpoint | null = null;
  private majorUsage = { bytes: 0, entries: 0 };
  /** Storage each landmark retained beyond the head, pins and newer landmarks,
   * as measured by the latest major pass. */
  private landmarkCost = new Map<string, { bytes: number; entries: number }>();
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
    const task = this.collectRetained(AbortSignal.timeout(30000), {
      policy: "generational",
    })
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
  /** All root construction must use beginWork; existing readers must own a pin.
   *
   * Collection is generational. A minor pass marks only content installed since
   * the previous successful sweep: the typed walk stops at surviving blobs,
   * whose complete closures an earlier sweep retained, and deletes only
   * unreachable young blobs. A major pass re-walks and verifies every retained
   * root and may thin optional seek landmarks under storage pressure. Within one
   * frozen pass, a subtree already walked under the same schema scope is not
   * walked again for another root. Explicit calls are major by default;
   * automatic maintenance uses the generational policy, which runs a major only
   * when surviving usage has grown substantially since the previous major.
   */
  collectRetained(
    signal: AbortSignal,
    options: { policy?: "major" | "generational" } = {},
  ) {
    return this.metadata(signal, async (active) => {
      if (this.activeWork)
        throw new ProtocolError(
          "retry_later",
          "Memory roots are under construction",
        );
      this.sweeping = true;
      try {
        const usage = this.usage,
          young = this.youngUsage;
        const survived = {
          bytes: usage.bytes - young.bytes,
          entries: usage.entries - young.entries,
        };
        const entryInterval = Math.max(
          1,
          Math.min(2048, Math.floor(this.maxEntries / 10)),
        );
        const grown = (
          current: number,
          major: number,
          interval: number,
          quota: number,
        ) =>
          current - major >= Math.max(interval, major / 2) ||
          (current >= quota * 0.75 && current - major >= interval);
        const major =
          options.policy !== "generational" ||
          grown(
            survived.bytes,
            this.majorUsage.bytes,
            this.collectionBytes,
            this.maxBytes,
          ) ||
          grown(
            survived.entries,
            this.majorUsage.entries,
            entryInterval,
            this.maxEntries,
          );
        // Seek landmarks are reconstructible from history. When the content
        // retained by the previous major exceeded 60% of either quota, drop
        // landmarks until their measured cost covers that excess, keeping the
        // most seek coverage per byte/entry. The head and every presentation
        // pin are retained independently. Publish the smaller catalog only
        // after a safe sweep. Only a major pass can reclaim landmark content.
        const share = (value: { bytes: number; entries: number }) =>
          Math.max(
            value.bytes / this.maxBytes,
            value.entries / this.maxEntries,
          );
        const excess = major ? share(this.majorUsage) - 0.6 : 0;
        let cheapest: number | undefined;
        for (const cost of this.landmarkCost.values()) {
          const value = share(cost);
          if (value > 0 && (cheapest === undefined || value < cheapest))
            cheapest = value;
        }
        const catalog =
          excess > 0
            ? thinSeekCheckpoints(
                this.catalog,
                (entry) => {
                  const cost = this.landmarkCost.get(canonicalJson(entry));
                  // Landmarks added since the last major are near the head
                  // and unmeasured; estimate them as the cheapest measured one
                  // so they compete for removal instead of forcing it onto
                  // older, more widely spaced landmarks.
                  return cost ? share(cost) : cheapest;
                },
                excess,
              )
            : this.catalog;
        // Walk the head and pins first, then landmarks from newest to oldest,
        // so each landmark's measured cost is what it retains beyond them.
        const roots = new Map<string, BrowserCheckpoint>();
        for (const root of [
          ...(this.head ? [this.head] : []),
          ...this.pins.values(),
          ...catalog.toReversed(),
        ])
          roots.set(canonicalJson(root), root);
        const landmarks = new Set(catalog.map((entry) => canonicalJson(entry)));
        const fixed = new Set(
          [...(this.head ? [this.head] : []), ...this.pins.values()].map(
            (entry) => canonicalJson(entry),
          ),
        );
        const costs = new Map<string, { bytes: number; entries: number }>();
        // Historical roots share most immutable metadata. Reuse bounded decoded
        // ranges within this frozen scan. Index nodes validated earlier in the
        // same pass (keyed by their complete span) are reused rather than
        // re-parsed on every pairing lookup; both caches die with the pass.
        const ranges = new Map<string, string>();
        let rangeBytes = 0;
        const nodes = new Map<string, unknown>();
        const content = {
          decodedNodes: {
            get: (key: string) => nodes.get(key),
            set: (key: string, value: unknown) => {
              if (nodes.size >= 1024) nodes.delete(nodes.keys().next().value!);
              nodes.set(key, value);
            },
          },
          put: this.put.bind(this),
          append: this.append.bind(this),
          read: async (
            ref: Parameters<MemoryPagedStore["read"]>[0],
            offset: number,
            length: number,
            signal?: AbortSignal,
          ) => {
            signal?.throwIfAborted();
            // Only exact descriptors share cache identity; others fail in read.
            const exact = parseContentReference(ref);
            if (!exact) return this.read(ref, offset, length, signal);
            const key = `${exact.hash}/${exact.byteSize}/${exact.units}/${offset}/${length}`;
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
        // Pass-local: a subtree entered earlier in this frozen pass either
        // completed (and marked its closure) or failed the whole pass.
        const walked = new Map<string, Set<string>>();
        const reuse = (ref: TextReference, scope: string) => {
          if (!major && this.survivor(ref.hash)) return true;
          let hashes = walked.get(scope);
          if (!hashes) walked.set(scope, (hashes = new Set()));
          if (hashes.has(ref.hash)) return true;
          hashes.add(ref.hash);
          return false;
        };
        const result = await super.collect(
          async (mark) => {
            for (const [key, root] of roots) {
              const spent = { bytes: 0, entries: 0 };
              await tracePairedSnapshot(
                content,
                root,
                this.binding,
                async (ref) => {
                  const added = await mark(ref);
                  spent.bytes += added.bytes;
                  spent.entries += added.entries;
                },
                active,
                reuse,
              );
              // A landmark equal to the head or a pin frees nothing if dropped.
              if (landmarks.has(key))
                costs.set(
                  key,
                  fixed.has(key) ? { bytes: 0, entries: 0 } : spent,
                );
            }
          },
          active,
          { minor: !major },
        );
        const dropped = this.catalog.length - catalog.length;
        this.catalog = catalog;
        if (major) {
          this.majorUsage = this.usage;
          this.landmarkCost = costs;
        }
        return { ...result, major, landmarks: catalog.length, dropped };
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
      // Space receipt landmarks by at least 1/64 of the receipt (no effect on
      // short recordings). Otherwise time-based landmarks, re-added every batch
      // of a long recording, crowd the head and, under storage pressure, force
      // thinning onto older and more widely spaced landmarks.
      const last = this.catalog.at(-1);
      if (
        !last ||
        next.serverSeq - last.serverSeq >= Math.floor(next.serverSeq / 64)
      )
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
        this.majorUsage = { bytes: 0, entries: 0 };
        this.landmarkCost.clear();
        this.view = undefined;
        this.attachment = undefined;
        this.pages = [];
        this.expansions = [];
      });
    }
    return this.metaClosed;
  }
}
