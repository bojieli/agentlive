import { mkdir, readFile, stat, realpath } from "node:fs/promises";
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
import { atomicJson, JsonlLog, FileLock } from "@agentlive/storage";

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
    !("adapterState" in raw)
  )
    throw new TypeError("Invalid captured source");
  canonicalJson(raw.adapterState);
  return {
    sourceKey: raw.sourceKey,
    events: raw.events.map((event) => publishedEventSchema.parse(event)),
    adapterState: raw.adapterState,
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

/** Durable local capture journal with exclusive kernel ownership per native-session binding. */
export class PublisherJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private nextSequence = 1;
  private closing = false;
  private readonly sourceBloom = new Uint32Array(32768);
  private adapterState: unknown = null;
  private constructor(
    readonly directory: string,
    private binding: PublisherBinding,
    private readonly log: JsonlLog<CapturedSource>,
    private readonly maxBytes: number,
    private readonly lock: FileLock,
  ) {}
  static async open(
    root: string,
    input: {
      serverOrigin: string;
      agent: PublisherBinding["nativeAgent"];
      nativeSessionId: string;
    },
    maxBytes = 512 * 1024 * 1024,
  ): Promise<PublisherJournal> {
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
      const log = await JsonlLog.open(join(directory, "capture.jsonl"), {
        parse: parseSource,
        maxRecordBytes: 4 * 1024 * 1024,
      });
      const journal = new PublisherJournal(
        directory,
        binding,
        log,
        maxBytes,
        lock,
      );
      try {
        for await (const record of log.read()) {
          for (const event of record.value.events) {
            if (
              event.producerSeq !== journal.nextSequence ||
              event.producerEpoch !== binding.producerEpoch ||
              event.streamId !== binding.streamId
            )
              throw new ProtocolError(
                "corrupt_storage",
                "Publisher journal identity/sequence mismatch",
              );
            journal.nextSequence++;
          }
          journal.rememberSource(record.value.sourceKey);
          journal.adapterState = record.value.adapterState;
        }
        if (binding.acknowledgedSeq >= journal.nextSequence)
          throw new ProtocolError(
            "corrupt_storage",
            "Publisher ACK exceeds captured prefix",
          );
        return journal;
      } catch (error) {
        await log.close();
        throw error;
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  /** Open an existing exact binding directory without inventing a new identity. */
  static async openExisting(directory: string): Promise<PublisherJournal> {
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
    return PublisherJournal.open(dirname(directory), {
      serverOrigin: binding.serverOrigin,
      agent: binding.nativeAgent,
      nativeSessionId: binding.nativeSessionId,
    });
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
      await this.save({ ...this.binding, revision, acknowledgedSeq: through });
    });
  }
  private sourceBits(key: string): number[] {
    const hash = createHash("sha256").update(key).digest();
    return [0, 4, 8, 12].map(
      (offset) => hash.readUInt32LE(offset) % (this.sourceBloom.length * 32),
    );
  }
  private rememberSource(key: string): void {
    for (const bit of this.sourceBits(key))
      this.sourceBloom[bit >>> 5] =
        (this.sourceBloom[bit >>> 5] ?? 0) | (1 << (bit & 31));
  }
  private mayHaveSource(key: string): boolean {
    return this.sourceBits(key).every(
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
  bindRemote(streamId: string, revision: string): Promise<void> {
    return this.serial(async () => {
      idSchema.parse(streamId);
      idSchema.parse(revision);
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
    });
  }
  capture(input: CaptureInput): Promise<readonly PublishedEvent[]> {
    const frozen = JSON.parse(canonicalJson(input)) as CaptureInput;
    return this.serial(async () => {
      if (!this.binding.sharingEnabled)
        throw new ProtocolError("forbidden", "Sharing is paused");
      if (!this.binding.streamId)
        throw new Error(
          "Remote session must be bound before assigning publishable events",
        );
      // Old retry lookup stays on disk; no unbounded in-memory source-ID dictionary.
      if (this.mayHaveSource(frozen.sourceKey))
        for await (const record of this.log.read())
          if (record.value.sourceKey === frozen.sourceKey) {
            if (
              canonicalJson(record.value.events.map((x) => x.content)) !==
              canonicalJson(frozen.content)
            )
              throw new ProtocolError(
                "event_conflict",
                "Source retry changed normalized content",
              );
            return record.value.events;
          }
      const events = frozen.content.map((content, index) =>
        publishedEventSchema.parse({
          protocolVersion: 1,
          streamId: this.binding.streamId,
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
      });
      if (
        (await stat(this.log.path)).size +
          Buffer.byteLength(canonicalJson(record)) +
          256 >
        this.maxBytes
      )
        throw new ProtocolError(
          "storage_failed",
          "Publisher spool capacity exceeded",
        );
      await this.log.append([record]);
      this.rememberSource(record.sourceKey);
      this.nextSequence += events.length;
      this.adapterState = record.adapterState;
      return events;
    });
  }
  async *pending(
    after = this.binding.acknowledgedSeq,
  ): AsyncGenerator<PublishedEvent> {
    if (!Number.isSafeInteger(after) || after < 0 || after >= this.nextSequence)
      throw new ProtocolError("cursor_invalid", "Invalid publisher cursor");
    for await (const record of this.log.read())
      for (const event of record.value.events)
        if (event.producerSeq > after) yield event;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    try {
      await this.log.close();
    } finally {
      await this.lock.release();
    }
  }
}
