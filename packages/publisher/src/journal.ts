import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  canonicalJson,
  publishedEventSchema,
  idSchema,
  ProtocolError,
  type PublishedEvent,
  type EventContent,
} from "@agentlive/protocol";
import {
  atomicJson,
  JsonlLog,
  FileLock,
  syncDirectory,
} from "@agentlive/storage";
import { RedactionGuard } from "./filter.js";
import {
  advancePublisherChain,
  atomicBytes,
  BLOOM_FILE,
  BLOOM_WORDS,
  bloomBits,
  compactedKeysFile,
  contentHash,
  decodeBloom,
  decodeKey,
  encodeBloom,
  encodeKeys,
  GENESIS_CHAIN,
  KEY_ENTRY_BYTES,
  keysDigest,
  MANIFEST_FILE,
  mergeKeys,
  parseManifest,
  readKeys,
  VerifiedKeyIndexes,
  segmentFile,
  segmentKeysFile,
  sourceKeyHash,
  UNBOUND_STREAM_ID,
  type CompactedMeta,
  type JournalManifest,
  type KeyEntry,
  type SegmentMeta,
} from "./journal-index.js";

export interface PublisherBinding {
  version: 1;
  serverOrigin: string;
  nativeAgent: PublishedEvent["source"]["agent"];
  nativeSessionId: string;
  publisherId: string;
  producerEpoch: string;
  creationRequestId: string;
  creationTime: string;
  writeSecret: string;
  streamId: string | null;
  revision: string | null;
  sharingEnabled: boolean;
  acknowledgedSeq: number;
  connectionAttempt: number;
  pendingCredentialRotation?: {
    operationId: string;
    revision: string;
    expectedVersion: number;
    replacementSecret: string;
  };
}
interface CapturedSource {
  sourceKey: string;
  events: PublishedEvent[];
  adapterState: unknown;
  /** Captured before the remote recording existed; events carry UNBOUND_STREAM_ID. */
  unbound?: true;
}
export interface CaptureInput {
  sourceKey: string;
  content: readonly EventContent[];
  observedAt: string;
  clockSegmentId: string;
  elapsedMs: number;
  fidelity: PublishedEvent["fidelity"];
  adapterState: unknown;
}
/** Bounded retention for long-lived publishers. */
export interface JournalRetention {
  /** Seal the active segment before an append would grow it beyond this many bytes. */
  segmentBytes: number;
  /**
   * Keep the newest acknowledged sealed segments up to this many bytes so
   * `recover-publisher` can republish a suffix lost by a server restore.
   */
  retainAcknowledgedBytes: number;
}
export type JournalFaultStep =
  | "rotate:keys"
  | "rotate:bloom"
  | "rotate:segment"
  | "rotate:manifest"
  | "compact:index"
  | "compact:manifest"
  | "compact:unlink";
export interface JournalOptions {
  /** Capacity for retained capture segments. */
  maxBytes?: number;
  /** Without retention the journal never rotates or compacts. */
  retention?: JournalRetention;
  /** Testing only: invoked after each durable rotation/compaction step. */
  faultInjection?: (step: JournalFaultStep) => void | Promise<void>;
}
/** Live file publishers: 8 MiB segments and 32 MiB of acknowledged recovery history. */
export const LIVE_JOURNAL_RETENTION: JournalRetention = {
  segmentBytes: 8 * 1024 * 1024,
  retainAcknowledgedBytes: 32 * 1024 * 1024,
};
const SAMPLE_STRIDE = 128;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const corrupt = (message: string) =>
  new ProtocolError("corrupt_storage", message);

const parseSource = (value: unknown): CapturedSource => {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid source journal record");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.sourceKey !== "string" ||
    !raw.sourceKey.length ||
    raw.sourceKey.length > 1024 ||
    !Array.isArray(raw.events) ||
    raw.events.length > 100 ||
    !("adapterState" in raw) ||
    ("unbound" in raw && raw.unbound !== true)
  )
    throw new TypeError("Invalid captured source");
  canonicalJson(raw.adapterState);
  return {
    sourceKey: raw.sourceKey,
    events: raw.events.map((event) => publishedEventSchema.parse(event)),
    adapterState: raw.adapterState,
    ...(raw.unbound === true ? { unbound: true as const } : {}),
  };
};
const parseBinding = (raw: unknown): PublisherBinding => {
  const binding = raw as PublisherBinding;
  if (
    !binding ||
    binding.version !== 1 ||
    !["claude", "codex", "kimi", "opencode", "synthetic"].includes(
      binding.nativeAgent,
    )
  )
    throw new Error("Invalid publisher binding");
  for (const value of [
    binding.publisherId,
    binding.producerEpoch,
    binding.creationRequestId,
    binding.nativeSessionId,
  ])
    idSchema.parse(value);
  if (
    typeof binding.writeSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.writeSecret)
  )
    throw new Error("Invalid stored credential");
  if (
    typeof binding.sharingEnabled !== "boolean" ||
    !Number.isSafeInteger(binding.acknowledgedSeq) ||
    binding.acknowledgedSeq < 0 ||
    !Number.isSafeInteger(binding.connectionAttempt) ||
    binding.connectionAttempt < 0
  )
    throw new Error("Invalid publisher cursor");
  if ((binding.streamId === null) !== (binding.revision === null))
    throw new Error("Incomplete remote binding");
  if (binding.streamId !== null) {
    idSchema.parse(binding.streamId);
    idSchema.parse(binding.revision);
  }
  if (!Number.isFinite(Date.parse(binding.creationTime)))
    throw new Error("Invalid creation time");
  new URL(binding.serverOrigin);
  if (binding.pendingCredentialRotation) {
    const pending = binding.pendingCredentialRotation;
    idSchema.parse(pending.operationId);
    idSchema.parse(pending.revision);
    if (
      pending.revision !== binding.revision ||
      !Number.isSafeInteger(pending.expectedVersion) ||
      pending.expectedVersion < 0 ||
      !/^[a-f0-9]{64}$/.test(pending.replacementSecret)
    )
      throw new Error("Invalid pending credential rotation");
  }
  return binding;
};

/** Binding directory name for an exact server origin and native session. */
export function publisherBindingKey(input: {
  serverOrigin: string;
  agent: PublisherBinding["nativeAgent"];
  nativeSessionId: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        serverOrigin: new URL(input.serverOrigin).origin,
        agent: input.agent,
        nativeSessionId: input.nativeSessionId,
      }),
    )
    .digest("hex");
}

const journalFile =
  /^(capture(-\d+)?\.jsonl(\.lock)?|capture-\d+\.keys|source-keys-\d+\.idx|source-bloom\.bin|journal\.json)$/;
const journalTemporary =
  /^\.(capture-\d+\.keys|source-keys-\d+\.idx|source-bloom\.bin|journal\.json)\.[0-9a-f-]+\.tmp$/;
/** Bytes of the capture journal files in one binding directory, without opening it. */
export async function publisherJournalBytes(
  directory: string,
): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const name of names)
    if (journalFile.test(name) && !name.endsWith(".lock"))
      try {
        total += (await lstat(join(directory, name))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
  return total;
}

interface OpenSegment {
  log: JsonlLog<CapturedSource>;
  /** First event sequence of records 1, 1 + SAMPLE_STRIDE, ... */
  samples: number[];
  readers: number;
  retired: boolean;
}
interface ActiveKey extends KeyEntry {
  sourceKey: string;
}

/**
 * Durable local capture journal with exclusive kernel ownership per native-session binding.
 *
 * Format: `capture.jsonl` alone is the original single-segment journal. The first
 * rotation writes `journal.json` (version 2), which lists retained segments
 * (`capture.jsonl`, `capture-<n>.jsonl`), sealed-segment source-key indexes and the
 * compacted prefix: its event hash chain, a merged source-key index and the adapter
 * checkpoint at the compaction boundary.
 */
export class PublisherJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private nextSequence = 1;
  private closing = false;
  private failed = false;
  private readonly sourceBloom = new Uint32Array(BLOOM_WORDS);
  private readonly keyIndexes = new VerifiedKeyIndexes();
  private guard: RedactionGuard | undefined;
  private adapterState: unknown = null;
  private manifest: JournalManifest | null = null;
  private readonly handles = new Map<number, Promise<OpenSegment>>();
  private activeKeys: Map<string, ActiveKey> | undefined;
  private chain = GENESIS_CHAIN;
  private lastUnbound = false;
  private constructor(
    readonly directory: string,
    private binding: PublisherBinding,
    private readonly lock: FileLock,
    private readonly maxBytes: number,
    private readonly retention: JournalRetention | undefined,
    private readonly fault: JournalOptions["faultInjection"],
  ) {
    if (retention) this.activeKeys = new Map();
  }
  static async open(
    root: string,
    input: {
      serverOrigin: string;
      agent: PublisherBinding["nativeAgent"];
      nativeSessionId: string;
    },
    options: number | JournalOptions = {},
  ): Promise<PublisherJournal> {
    const settings =
      typeof options === "number" ? { maxBytes: options } : options;
    const maxBytes = settings.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid publisher spool capacity");
    if (
      settings.retention &&
      (!Number.isSafeInteger(settings.retention.segmentBytes) ||
        settings.retention.segmentBytes < 1024 ||
        !Number.isSafeInteger(settings.retention.retainAcknowledgedBytes) ||
        settings.retention.retainAcknowledgedBytes < 0)
    )
      throw new RangeError("Invalid publisher journal retention");
    const url = new URL(input.serverOrigin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("Expected server origin without credentials or path");
    idSchema.parse(input.nativeSessionId);
    const key = publisherBindingKey({ ...input, serverOrigin: url.origin });
    const directory = join(root, key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await FileLock.acquire(join(directory, ".publisher.lock"));
    try {
      let binding: PublisherBinding;
      try {
        binding = parseBinding(
          JSON.parse(await readFile(join(directory, "binding.json"), "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        binding = {
          version: 1,
          serverOrigin: url.origin,
          nativeAgent: input.agent,
          nativeSessionId: input.nativeSessionId,
          publisherId: randomUUID(),
          producerEpoch: randomUUID(),
          creationRequestId: randomUUID(),
          creationTime: new Date().toISOString(),
          writeSecret: randomBytes(32).toString("hex"),
          streamId: null,
          revision: null,
          sharingEnabled: true,
          acknowledgedSeq: 0,
          connectionAttempt: 0,
        };
        await atomicJson(join(directory, "binding.json"), binding);
      }
      if (
        binding.serverOrigin !== url.origin ||
        binding.nativeAgent !== input.agent ||
        binding.nativeSessionId !== input.nativeSessionId
      )
        throw new Error("Binding identity conflict");
      const journal = new PublisherJournal(
        directory,
        binding,
        lock,
        maxBytes,
        settings.retention,
        settings.faultInjection,
      );
      try {
        await journal.load();
        return journal;
      } catch (error) {
        await journal.closeSegments();
        throw error;
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  /** Open an existing exact binding directory without inventing a new identity. */
  static async openExisting(
    directory: string,
    options: JournalOptions = {},
  ): Promise<PublisherJournal> {
    directory = await realpath(directory);
    const binding = parseBinding(
      JSON.parse(await readFile(join(directory, "binding.json"), "utf8")),
    );
    const key = publisherBindingKey({
      serverOrigin: new URL(binding.serverOrigin).origin,
      agent: binding.nativeAgent,
      nativeSessionId: binding.nativeSessionId,
    });
    if (basename(directory) !== key)
      throw new Error("Publisher directory identity differs");
    return PublisherJournal.open(
      dirname(directory),
      {
        serverOrigin: binding.serverOrigin,
        agent: binding.nativeAgent,
        nativeSessionId: binding.nativeSessionId,
      },
      options,
    );
  }

  private get segments(): readonly SegmentMeta[] {
    return this.manifest?.segments ?? [{ id: 0, firstSeq: 1 }];
  }
  private get active(): SegmentMeta {
    return this.segments.at(-1)!;
  }
  private get compaction(): CompactedMeta | null {
    return this.manifest?.compacted ?? null;
  }
  private path(name: string) {
    return join(this.directory, name);
  }

  private async load(): Promise<void> {
    let manifest: JournalManifest | null = null;
    try {
      manifest = parseManifest(
        JSON.parse(await readFile(this.path(MANIFEST_FILE), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof ProtocolError) throw error;
        throw corrupt("Invalid publisher journal manifest");
      }
    }
    this.manifest = manifest;
    await this.removeOrphans();
    const compacted = this.compaction;
    const sealed = this.segments.filter((segment) => segment.sealed);
    for (const segment of sealed) {
      const size = await stat(this.path(segmentFile(segment.id))).then(
        (info) => info.size,
        () => -1,
      );
      const keys = await stat(this.path(segmentKeysFile(segment.id))).then(
        (info) => info.size,
        () => -1,
      );
      if (
        size !== segment.sealed!.bytes ||
        keys !== segment.sealed!.keys * KEY_ENTRY_BYTES
      )
        throw corrupt("Sealed publisher journal segment is missing or changed");
    }
    if (compacted) {
      const size = await stat(
        this.path(compactedKeysFile(compacted.generation)),
      ).then(
        (info) => info.size,
        () => -1,
      );
      if (size !== compacted.keys * KEY_ENTRY_BYTES)
        throw corrupt("Compacted source-key index is missing or changed");
    }
    if (manifest && (sealed.length || compacted)) await this.loadBloom();
    const lastSealed = sealed.at(-1)?.sealed;
    this.chain = lastSealed?.chain ?? compacted?.chain ?? GENESIS_CHAIN;
    this.lastUnbound = lastSealed?.endsUnbound ?? false;
    const active = this.active;
    this.nextSequence = active.firstSeq;
    const log = await JsonlLog.open(this.path(segmentFile(active.id)), {
      parse: parseSource,
      maxRecordBytes: MAX_RECORD_BYTES,
      indexStride: SAMPLE_STRIDE,
    });
    const segment: OpenSegment = {
      log,
      samples: [],
      readers: 0,
      retired: false,
    };
    this.handles.set(active.id, Promise.resolve(segment));
    let records = 0;
    for await (const record of log.read()) {
      records++;
      this.accept(segment, record.sequence, record.value);
    }
    if (!records)
      this.adapterState = lastSealed
        ? await this.lastAdapterState(sealed.at(-1)!)
        : (compacted?.adapterState ?? null);
    if (this.binding.acknowledgedSeq >= this.nextSequence)
      throw corrupt("Publisher ACK exceeds captured prefix");
    if (this.binding.acknowledgedSeq < (compacted?.throughSeq ?? 0))
      throw corrupt("Publisher ACK precedes compacted history");
  }
  /** Validate and index one record appended to (or replayed from) the active segment. */
  private accept(
    segment: OpenSegment,
    recordSequence: number,
    record: CapturedSource,
  ): void {
    this.validateRecord(record, this.nextSequence, this.lastUnbound);
    if ((recordSequence - 1) % SAMPLE_STRIDE === 0)
      segment.samples.push(this.nextSequence);
    const key = sourceKeyHash(record.sourceKey);
    this.activeKeys?.set(key.toString("hex"), {
      key,
      sourceKey: record.sourceKey,
      firstSeq: this.nextSequence,
      count: record.events.length,
      content: contentHash(record.events.map((event) => event.content)),
    });
    this.rememberSource(key);
    for (const event of record.events)
      this.chain = advancePublisherChain(this.chain, event);
    this.nextSequence += record.events.length;
    this.adapterState = record.adapterState;
    this.lastUnbound = record.unbound === true;
  }
  private validateRecord(
    record: CapturedSource,
    firstSeq: number,
    previousUnbound: boolean | undefined,
  ): void {
    if (record.unbound) {
      // Unbound records form a prefix; binding never returns to the placeholder.
      if (
        previousUnbound === false &&
        firstSeq > 1 &&
        this.hasBoundBefore(firstSeq)
      )
        throw corrupt("Unbound publisher record follows a bound record");
    } else if (this.binding.streamId === null)
      throw corrupt("Publisher journal has events for an unknown recording");
    let sequence = firstSeq;
    for (const event of record.events)
      if (
        event.producerSeq !== sequence++ ||
        event.producerEpoch !== this.binding.producerEpoch ||
        event.streamId !==
          (record.unbound ? UNBOUND_STREAM_ID : this.binding.streamId)
      )
        throw corrupt("Publisher journal identity/sequence mismatch");
  }
  /** Whether any captured record before firstSeq was bound (conservative). */
  private hasBoundBefore(firstSeq: number): boolean {
    return firstSeq > 1 && !this.lastUnbound;
  }
  private async removeOrphans(): Promise<void> {
    const keep = new Set<string>();
    for (const segment of this.segments) {
      keep.add(segmentFile(segment.id));
      keep.add(segmentFile(segment.id) + ".lock");
      if (segment.sealed) keep.add(segmentKeysFile(segment.id));
    }
    if (this.manifest) {
      keep.add(MANIFEST_FILE);
      keep.add(BLOOM_FILE);
    }
    const compacted = this.compaction;
    if (compacted) keep.add(compactedKeysFile(compacted.generation));
    let removed = false;
    for (const name of await readdir(this.directory))
      if (
        (journalFile.test(name) && !keep.has(name) && name !== MANIFEST_FILE) ||
        journalTemporary.test(name)
      ) {
        await unlink(this.path(name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        removed = true;
      }
    if (removed) await syncDirectory(this.directory);
  }
  private async loadBloom(): Promise<void> {
    try {
      if (decodeBloom(await readFile(this.path(BLOOM_FILE)), this.sourceBloom))
        return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.sourceBloom.fill(0);
    for (const segment of this.segments)
      if (segment.sealed)
        for await (const entry of readKeys(
          this.path(segmentKeysFile(segment.id)),
          segment.sealed.keys,
          segment.sealed.keysHash,
        ))
          this.rememberSource(entry.subarray(0, 16));
    const compacted = this.compaction;
    if (compacted)
      for await (const entry of readKeys(
        this.path(compactedKeysFile(compacted.generation)),
        compacted.keys,
        compacted.keysHash,
      ))
        this.rememberSource(entry.subarray(0, 16));
    await atomicBytes(this.path(BLOOM_FILE), [encodeBloom(this.sourceBloom)]);
  }
  /** Open (once) a retained segment for reading; callers release it. */
  private acquire(meta: SegmentMeta): Promise<OpenSegment> {
    let handle = this.handles.get(meta.id);
    if (!handle) {
      handle = this.openSealed(meta);
      this.handles.set(meta.id, handle);
      handle.catch(() => {
        if (this.handles.get(meta.id) === handle) this.handles.delete(meta.id);
      });
    }
    return handle.then((segment) => {
      segment.readers++;
      return segment;
    });
  }
  private async release(id: number, segment: OpenSegment): Promise<void> {
    segment.readers--;
    if (segment.retired && segment.readers === 0) {
      if (this.handles.get(id)) this.handles.delete(id);
      await segment.log.close();
    }
  }
  private async openSealed(meta: SegmentMeta): Promise<OpenSegment> {
    const sealed = meta.sealed;
    if (!sealed) throw new Error("Active segment is always open");
    const log = await JsonlLog.open(this.path(segmentFile(meta.id)), {
      parse: parseSource,
      maxRecordBytes: MAX_RECORD_BYTES,
      indexStride: SAMPLE_STRIDE,
    });
    try {
      const boundary = log.boundary;
      if (
        boundary.sequence !== sealed.records ||
        boundary.byteOffset !== sealed.bytes ||
        boundary.hash !== sealed.hash
      )
        throw corrupt("Sealed publisher journal segment changed");
      const samples: number[] = [];
      let sequence = meta.firstSeq;
      for await (const record of log.read()) {
        if ((record.sequence - 1) % SAMPLE_STRIDE === 0) samples.push(sequence);
        this.validateRecord(record.value, sequence, undefined);
        sequence += record.value.events.length;
      }
      if (sequence - 1 !== sealed.lastSeq)
        throw corrupt("Sealed publisher journal segment boundary differs");
      return { log, samples, readers: 0, retired: false };
    } catch (error) {
      await log.close();
      throw error;
    }
  }
  private async lastAdapterState(meta: SegmentMeta): Promise<unknown> {
    const segment = await this.acquire(meta);
    try {
      const records = segment.log.boundary.sequence;
      for await (const record of segment.log.read(records - 1, records))
        return record.value.adapterState;
      throw corrupt("Sealed publisher journal segment is empty");
    } finally {
      await this.release(meta.id, segment);
    }
  }
  /** Records starting at or before the first record that may contain `sequence`. */
  private startRecord(segment: OpenSegment, sequence: number): number {
    let low = 0,
      high = segment.samples.length - 1,
      found = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (segment.samples[middle]! <= sequence) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found * SAMPLE_STRIDE;
  }
  private bound(record: CapturedSource, event: PublishedEvent): PublishedEvent {
    return record.unbound && this.binding.streamId
      ? { ...event, streamId: this.binding.streamId }
      : event;
  }

  /** Persist the replacement before attempting its remote installation. */
  prepareCredentialRotation(expectedVersion: number, restart = false) {
    return this.serial(async () => {
      if (
        !this.binding.streamId ||
        !this.binding.revision ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      )
        throw new Error("Invalid credential rotation binding");
      if (restart || !this.binding.pendingCredentialRotation) {
        await this.save({
          ...this.binding,
          pendingCredentialRotation: {
            operationId: randomUUID(),
            revision: this.binding.revision,
            expectedVersion,
            replacementSecret: randomBytes(32).toString("hex"),
          },
        });
      }
      return { ...this.binding.pendingCredentialRotation! };
    });
  }
  confirmCredentialRotation(operationId: string) {
    return this.serial(async () => {
      const { pendingCredentialRotation: pending, ...binding } = this.binding;
      if (!pending || pending.operationId !== operationId)
        throw new Error("Pending credential rotation differs");
      await this.save({ ...binding, writeSecret: pending.replacementSecret });
    });
  }
  /** Only use after comparing the restored server's entire publisher prefix. */
  recoverRevision(
    previousRevision: string,
    revision: string,
    through: number,
  ): Promise<void> {
    return this.serial(async () => {
      if (this.binding.pendingCredentialRotation)
        throw new Error(
          "Complete pending credential rotation before revision recovery",
        );
      idSchema.parse(revision);
      if (
        !this.binding.streamId ||
        this.binding.revision !== previousRevision ||
        previousRevision === revision
      )
        throw new ProtocolError(
          "revision_changed",
          "Publisher recovery revision differs",
        );
      if (
        !Number.isSafeInteger(through) ||
        through < 0 ||
        through >= this.nextSequence
      )
        throw new ProtocolError(
          "sequence_gap",
          "Restored prefix exceeds captured history",
        );
      if (through < this.compactedThrough)
        throw new ProtocolError(
          "sequence_gap",
          "Restored prefix precedes locally compacted history",
        );
      await this.save({ ...this.binding, revision, acknowledgedSeq: through });
    });
  }
  private rememberSource(key: Buffer): void {
    for (const bit of bloomBits(key))
      this.sourceBloom[bit >>> 5] =
        (this.sourceBloom[bit >>> 5] ?? 0) | (1 << (bit & 31));
  }
  private mayHaveSource(key: Buffer): boolean {
    return bloomBits(key).every(
      (bit) => ((this.sourceBloom[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0,
    );
  }
  get identity(): PublisherBinding {
    return {
      ...this.binding,
      ...(this.binding.pendingCredentialRotation
        ? {
            pendingCredentialRotation: {
              ...this.binding.pendingCredentialRotation,
            },
          }
        : {}),
    };
  }
  get capturedThrough(): number {
    return this.nextSequence - 1;
  }
  get checkpoint(): unknown {
    return JSON.parse(canonicalJson(this.adapterState));
  }
  /** Events through this sequence were acknowledged and their records removed. */
  get compactedThrough(): number {
    return this.compaction?.throughSeq ?? 0;
  }
  /** Event hash chain through `compactedThrough` (see advancePublisherChain). */
  get compactedChain(): string {
    return this.compaction?.chain ?? GENESIS_CHAIN;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("storage_failed", "Publisher journal is closing"),
      );
    const run = this.tail.then(operation);
    this.tail = run.catch(() => {});
    return run;
  }
  private async save(binding: PublisherBinding): Promise<void> {
    await atomicJson(join(this.directory, "binding.json"), binding);
    this.binding = binding;
  }
  private async commitManifest(manifest: JournalManifest): Promise<void> {
    try {
      await atomicJson(this.path(MANIFEST_FILE), manifest);
    } catch (error) {
      // The rename may have happened; only a reopen can tell which manifest is durable.
      this.failed = true;
      throw error;
    }
    this.manifest = manifest;
  }
  bindRemote(streamId: string, revision: string): Promise<void> {
    return this.serial(async () => {
      idSchema.parse(streamId);
      idSchema.parse(revision);
      if (streamId === UNBOUND_STREAM_ID)
        throw new ProtocolError(
          "invalid_request",
          "Remote recording identity collides with the unbound placeholder",
        );
      if (
        this.binding.streamId !== null &&
        (this.binding.streamId !== streamId ||
          this.binding.revision !== revision)
      )
        throw new ProtocolError(
          "revision_changed",
          "Cannot replace a durable remote binding",
        );
      await this.save({ ...this.binding, streamId, revision });
    });
  }
  setSharing(enabled: boolean): Promise<void> {
    return this.serial(() =>
      this.save({ ...this.binding, sharingEnabled: enabled }),
    );
  }
  nextConnectionAttempt(): Promise<number> {
    return this.serial(async () => {
      const attempt = this.binding.connectionAttempt + 1;
      if (!Number.isSafeInteger(attempt))
        throw new Error("Connection attempt exhausted");
      await this.save({ ...this.binding, connectionAttempt: attempt });
      return attempt;
    });
  }
  acknowledge(through: number): Promise<void> {
    return this.serial(async () => {
      if (
        !Number.isSafeInteger(through) ||
        through < this.binding.acknowledgedSeq ||
        through >= this.nextSequence
      )
        throw new ProtocolError(
          "sequence_gap",
          "Invalid durable server acknowledgement",
        );
      await this.save({ ...this.binding, acknowledgedSeq: through });
      await this.compact();
    });
  }
  private retainedBytes(active: OpenSegment): number {
    let total = active.log.boundary.byteOffset;
    for (const segment of this.segments)
      if (segment.sealed) total += segment.sealed.bytes;
    return total;
  }
  private async activeSegment(): Promise<OpenSegment> {
    const handle = this.handles.get(this.active.id);
    if (!handle) throw new Error("Active publisher segment is closed");
    return handle;
  }
  /** Locate a previously captured source record by key hash. */
  private async findSource(
    sourceKey: string,
    key: Buffer,
  ): Promise<{ entry: KeyEntry; segment: SegmentMeta | null } | undefined> {
    const active = this.active;
    if (this.activeKeys) {
      const hit = this.activeKeys.get(key.toString("hex"));
      if (hit) return { entry: hit, segment: active };
    } else {
      const segment = await this.activeSegment();
      let sequence = active.firstSeq;
      for await (const record of segment.log.read()) {
        if (record.value.sourceKey === sourceKey)
          return {
            entry: {
              key,
              firstSeq: sequence,
              count: record.value.events.length,
              content: contentHash(
                record.value.events.map((event) => event.content),
              ),
            },
            segment: active,
          };
        sequence += record.value.events.length;
      }
    }
    for (const segment of [...this.segments].reverse()) {
      if (!segment.sealed) continue;
      const hit = await this.keyIndexes.search(
        this.path(segmentKeysFile(segment.id)),
        segment.sealed.keys,
        segment.sealed.keysHash,
        key,
      );
      if (hit) return { entry: hit, segment };
    }
    const compacted = this.compaction;
    if (compacted) {
      const hit = await this.keyIndexes.search(
        this.path(compactedKeysFile(compacted.generation)),
        compacted.keys,
        compacted.keysHash,
        key,
      );
      if (hit) return { entry: hit, segment: null };
    }
    return undefined;
  }
  private async recordEvents(
    meta: SegmentMeta,
    sourceKey: string,
    firstSeq: number,
  ): Promise<PublishedEvent[]> {
    const segment =
      meta.id === this.active.id
        ? await this.activeSegment()
        : await this.acquire(meta);
    try {
      let sequence =
        segment.samples[this.startRecord(segment, firstSeq) / SAMPLE_STRIDE] ??
        meta.firstSeq;
      for await (const record of segment.log.read(
        this.startRecord(segment, firstSeq),
      )) {
        if (record.value.sourceKey === sourceKey && sequence === firstSeq)
          return record.value.events.map((event) =>
            this.bound(record.value, event),
          );
        sequence += record.value.events.length;
        if (sequence > firstSeq) break;
      }
      throw new ProtocolError(
        "event_conflict",
        "Source key index differs from the captured record",
      );
    } finally {
      if (meta.id !== this.active.id) await this.release(meta.id, segment);
    }
  }
  /**
   * Durably assign producer sequences to one native source record. Before the remote
   * recording exists, events are journaled with a placeholder stream identity and
   * delivered with the real one once `bindRemote` succeeds. A retry of an already
   * captured source key returns its stored events, or `[]` when that record has been
   * compacted after acknowledgement (its content hash is still checked).
   */
  /**
   * Install the values this publisher filters. Every later capture is checked
   * against them, so a field an adapter forgot to redact stops the publisher
   * instead of reaching the server. Call it once, with the same dictionary the
   * adapters redact with.
   */
  enforceRedaction(secrets: readonly string[]): void {
    this.guard = new RedactionGuard(secrets);
  }
  capture(input: CaptureInput): Promise<readonly PublishedEvent[]> {
    const encoded = canonicalJson(input);
    const frozen = JSON.parse(encoded) as CaptureInput;
    return this.serial(async () => {
      // Before anything is written, and over the whole encoding rather than the
      // fields an adapter happened to treat as text.
      this.guard?.assertClean(encoded, "A captured event");
      if (this.failed)
        throw new ProtocolError(
          "storage_failed",
          "Publisher journal requires reopening after a storage failure",
        );
      if (!this.binding.sharingEnabled)
        throw new ProtocolError("forbidden", "Sharing is paused");
      const key = sourceKeyHash(frozen.sourceKey);
      // Old retry lookups stay on disk; only the bounded active segment is indexed in memory.
      if (this.mayHaveSource(key)) {
        const found = await this.findSource(frozen.sourceKey, key);
        if (found) {
          if (!found.entry.content.equals(contentHash(frozen.content)))
            throw new ProtocolError(
              "event_conflict",
              "Source retry changed normalized content",
            );
          if (!found.segment) return [];
          return await this.recordEvents(
            found.segment,
            frozen.sourceKey,
            found.entry.firstSeq,
          );
        }
      }
      const unbound = this.binding.streamId === null;
      const events = frozen.content.map((content, index) =>
        publishedEventSchema.parse({
          protocolVersion: 1,
          streamId: this.binding.streamId ?? UNBOUND_STREAM_ID,
          producerEpoch: this.binding.producerEpoch,
          producerSeq: this.nextSequence + index,
          observedAt: frozen.observedAt,
          clockSegmentId: frozen.clockSegmentId,
          elapsedMs: frozen.elapsedMs,
          fidelity: frozen.fidelity,
          source: {
            agent: this.binding.nativeAgent,
            sessionId: this.binding.nativeSessionId,
            eventId: frozen.sourceKey,
          },
          content,
        }),
      );
      const record = parseSource({
        sourceKey: frozen.sourceKey,
        events,
        adapterState: frozen.adapterState,
        ...(unbound ? { unbound: true } : {}),
      });
      const recordBytes = Buffer.byteLength(canonicalJson(record)) + 256;
      let active = await this.activeSegment();
      if (this.retainedBytes(active) + recordBytes > this.maxBytes)
        throw new ProtocolError(
          "storage_failed",
          "Publisher spool capacity exceeded",
        );
      if (
        this.retention &&
        active.log.boundary.sequence > 0 &&
        active.log.boundary.byteOffset + recordBytes >
          this.retention.segmentBytes
      ) {
        await this.rotate(active);
        active = await this.activeSegment();
      }
      const [entry] = await active.log.append([record]);
      this.accept(active, entry!.sequence, record);
      return events;
    });
  }
  /** Seal the active segment and start the next one; see removeOrphans for crash cleanup. */
  private async rotate(current: OpenSegment): Promise<void> {
    const meta = this.active;
    const boundary = current.log.boundary;
    const keys = encodeKeys([...this.activeKeys!.values()]);
    await atomicBytes(this.path(segmentKeysFile(meta.id)), [keys]);
    await this.fault?.("rotate:keys");
    await atomicBytes(this.path(BLOOM_FILE), [encodeBloom(this.sourceBloom)]);
    await this.fault?.("rotate:bloom");
    const next = { id: meta.id + 1, firstSeq: this.nextSequence };
    const log = await JsonlLog.open(this.path(segmentFile(next.id)), {
      parse: parseSource,
      maxRecordBytes: MAX_RECORD_BYTES,
      indexStride: SAMPLE_STRIDE,
    });
    try {
      if (log.boundary.sequence !== 0)
        throw corrupt("New publisher journal segment is not empty");
      await this.fault?.("rotate:segment");
      await this.commitManifest({
        version: 2,
        segments: [
          ...this.segments.slice(0, -1),
          {
            ...meta,
            sealed: {
              records: boundary.sequence,
              bytes: boundary.byteOffset,
              hash: boundary.hash,
              lastSeq: this.nextSequence - 1,
              chain: this.chain,
              keys: keys.length / KEY_ENTRY_BYTES,
              keysHash: keysDigest(keys),
              endsUnbound: this.lastUnbound,
            },
          },
          next,
        ],
        compacted: this.compaction,
      });
    } catch (error) {
      await log.close();
      throw error;
    }
    // The previous active log stays open for concurrent readers until compacted.
    this.handles.set(
      next.id,
      Promise.resolve({ log, samples: [], readers: 0, retired: false }),
    );
    this.activeKeys = new Map();
    await this.fault?.("rotate:manifest");
    await this.compact();
  }
  /**
   * Remove sealed segments whose events the server acknowledged, keeping the newest
   * `retainAcknowledgedBytes` of them. Their source keys move into the merged index;
   * their events survive only as the compacted hash chain.
   */
  private async compact(): Promise<void> {
    if (!this.retention || !this.manifest || this.failed) return;
    const acknowledged = this.segments.filter(
      (segment) =>
        segment.sealed &&
        segment.sealed.lastSeq <= this.binding.acknowledgedSeq,
    );
    let count = acknowledged.length,
      kept = 0;
    while (
      count > 0 &&
      kept + acknowledged[count - 1]!.sealed!.bytes <=
        this.retention.retainAcknowledgedBytes
    )
      kept += acknowledged[--count]!.sealed!.bytes;
    const prune = acknowledged.slice(0, count);
    if (!prune.length) return;
    const previous = this.compaction;
    const fresh: Buffer[] = [];
    for (const segment of prune)
      for await (const entry of readKeys(
        this.path(segmentKeysFile(segment.id)),
        segment.sealed!.keys,
        segment.sealed!.keysHash,
      ))
        fresh.push(entry);
    fresh.sort((a, b) => Buffer.compare(a.subarray(0, 16), b.subarray(0, 16)));
    const generation = (previous?.generation ?? 0) + 1;
    const digest = createHash("sha256");
    let entries = 0;
    const base = previous
      ? readKeys(
          this.path(compactedKeysFile(previous.generation)),
          previous.keys,
          previous.keysHash,
        )
      : (async function* () {})();
    const self = this;
    await atomicBytes(
      this.path(compactedKeysFile(generation)),
      (async function* () {
        let batch: Buffer[] = [];
        for await (const entry of mergeKeys(base, fresh)) {
          decodeKey(entry);
          digest.update(entry);
          entries++;
          batch.push(entry);
          if (batch.length === 16384) {
            yield Buffer.concat(batch);
            batch = [];
          }
        }
        if (batch.length) yield Buffer.concat(batch);
        void self;
      })(),
    );
    await this.fault?.("compact:index");
    const last = prune.at(-1)!;
    const adapterState = await this.lastAdapterState(last);
    await this.commitManifest({
      version: 2,
      segments: this.segments.slice(prune.length),
      compacted: {
        throughSeq: last.sealed!.lastSeq,
        chain: last.sealed!.chain,
        generation,
        keys: entries,
        keysHash: digest.digest("hex"),
        adapterState,
      },
    });
    await this.fault?.("compact:manifest");
    for (const segment of prune) {
      const handle = this.handles.get(segment.id);
      if (handle) {
        const open = await handle.catch(() => undefined);
        if (open) {
          open.retired = true;
          if (open.readers === 0) {
            this.handles.delete(segment.id);
            await open.log.close();
          }
        } else this.handles.delete(segment.id);
      }
      for (const name of [
        segmentFile(segment.id),
        segmentFile(segment.id) + ".lock",
        segmentKeysFile(segment.id),
      ])
        await unlink(this.path(name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    if (previous)
      await unlink(this.path(compactedKeysFile(previous.generation))).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    await syncDirectory(this.directory);
    await this.fault?.("compact:unlink");
  }
  /**
   * Retained events after `after`, with unbound placeholders replaced by the bound
   * stream identity. History at or before `compactedThrough` is no longer readable.
   */
  async *pending(
    after = this.binding.acknowledgedSeq,
  ): AsyncGenerator<PublishedEvent> {
    if (!Number.isSafeInteger(after) || after < 0 || after >= this.nextSequence)
      throw new ProtocolError("cursor_invalid", "Invalid publisher cursor");
    if (after < this.compactedThrough)
      throw new ProtocolError(
        "cursor_invalid",
        "Publisher journal history before this cursor was compacted after acknowledgement",
        { compactedThrough: this.compactedThrough },
      );
    const activeId = this.active.id;
    for (const meta of [...this.segments]) {
      if (meta.sealed && meta.sealed.lastSeq <= after) continue;
      const segment =
        meta.id === activeId && !meta.sealed
          ? await this.acquireActive(meta.id)
          : await this.acquire(meta);
      try {
        const start = this.startRecord(segment, after + 1);
        for await (const record of segment.log.read(start))
          for (const event of record.value.events)
            if (event.producerSeq > after)
              yield this.bound(record.value, event);
      } finally {
        await this.release(meta.id, segment);
      }
    }
  }
  private async acquireActive(id: number): Promise<OpenSegment> {
    const handle = this.handles.get(id);
    if (!handle) throw new Error("Active publisher segment is closed");
    const segment = await handle;
    segment.readers++;
    return segment;
  }
  private async closeSegments(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    let failure: unknown;
    for (const handle of handles) {
      const segment = await handle.catch(() => undefined);
      try {
        await segment?.log.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    try {
      await this.closeSegments();
    } finally {
      await this.lock.release();
    }
  }
}
