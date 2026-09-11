import { RecordingSnapshots } from "./snapshots.js";
import type { WriteBarrier } from "./write-barrier.js";
import type { RecordingUsage } from "./quotas.js";
import type { ContentReference } from "@agentlive/playback";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  atomicJson,
  JsonlLog,
  BlobStore,
  type BlobDescriptor,
  type LogBoundary,
} from "@agentlive/storage";
import {
  canonicalJson,
  migrationOriginSchema,
  archiveOriginSchema,
  type MigrationOrigin,
  idSchema,
  cursorSchema,
  storedEventSchema,
  publishedEventSchema,
  ProtocolError,
  type StoredEvent,
  type PublishedEvent,
  type EventContent,
} from "@agentlive/protocol";

export const sessionMetadataSchema = z.strictObject({
  version: z.literal(1),
  id: idSchema,
  revision: idSchema,
  ownerId: idSchema,
  title: z.string().max(500),
  visibility: z.enum(["public", "unlisted", "private"]),
  migrationOrigin: migrationOriginSchema.optional(),
  archiveOrigin: archiveOriginSchema.optional(),
  removed: z
    .strictObject({
      operationId: idSchema,
      removedAt: z.number().int().nonnegative().safe(),
    })
    .optional(),
  visibilityChange: z
    .strictObject({
      version: cursorSchema,
      operationId: idSchema,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  creationRequestId: idSchema,
  creationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  publisherCredential: z
    .strictObject({
      version: cursorSchema,
      revoked: z.boolean(),
      operationId: idSchema,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  publisherId: idSchema,
  producerEpoch: idSchema,
  leaseGeneration: cursorSchema,
  lastAttempt: cursorSchema,
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export interface Lease {
  publisherId: string;
  producerEpoch: string;
  generation: number;
  attempt: number;
}
export interface PublisherAck {
  producerEpoch: string;
  throughProducerSeq: number;
  serverSeq: number;
  revision: string;
}
export interface Subscriber {
  deliver: (event: StoredEvent) => void;
  invalidate: (reason: string) => void;
}
export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** All authoritative recording mutations and subscription boundaries share this queue. */
export class RecordingSession {
  private snapshots: RecordingSnapshots;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private removalUncertain = false;
  private migrationUncertain = false;
  private state: "open" | "ended" = "open";
  private appliedLifecycle = 0;
  private producerThrough = 0;
  private producerServerSeq = 0;
  private timeline = 0;
  private lease: Lease | null = null;
  private readonly segments = new Map<
    string,
    { elapsedMs: number; timelineMs: number; lastElapsedMs: number }
  >();
  private readonly subscribers = new Set<Subscriber>();
  private readonly readers = new Set<AbortController>();
  /** Lifetime of any HTTP response, independent of its authorization kind. */
  acquireRead(parent?: AbortSignal) {
    this.assertAvailable();
    if (this.closing)
      throw new ProtocolError("stream_gone", "Session is closing");
    if (this.readers.size >= 4096)
      throw new ProtocolError("retry_later", "Too many recording reads");
    const stop = new AbortController();
    const close = () => {
      this.readers.delete(stop);
      parent?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      stop.abort(parent?.reason);
      close();
    };
    this.readers.add(stop);
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    return { signal: stop.signal, close };
  }
  private cancelReads() {
    for (const reader of this.readers)
      reader.abort(
        new ProtocolError("stream_gone", "Recording is unavailable"),
      );
    this.readers.clear();
  }
  private readonly publicReaders = new Set<AbortController>();
  acquirePublicRead(parent?: AbortSignal) {
    this.assertAvailable();
    if (this.closing)
      throw new ProtocolError("stream_gone", "Session is closing");
    if (this.metadata.visibility === "private") return undefined;
    if (this.publicReaders.size >= 4096)
      throw new ProtocolError("retry_later", "Too many public reads");
    const stop = new AbortController();
    const close = () => {
      this.publicReaders.delete(stop);
      parent?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      stop.abort(parent?.reason);
      close();
    };
    this.publicReaders.add(stop);
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    return { signal: stop.signal, close };
  }
  private cancelPublicReads() {
    for (const reader of this.publicReaders)
      reader.abort(
        new ProtocolError("forbidden", "Public viewing authorization ended"),
      );
    this.publicReaders.clear();
  }
  private readonly attachmentVersions = new Map<
    string,
    Map<number, BlobDescriptor>
  >();
  private readonly referencedBlobs = new Set<string>();
  private readonly operations = new Map<
    string,
    { digest: string; result: StoredEvent }
  >();
  private constructor(
    readonly directory: string,
    private metadata: SessionMetadata,
    private readonly log: JsonlLog<StoredEvent>,
    private readonly blobs: BlobStore,
    private readonly barrier?: WriteBarrier,
    private readonly usage?: RecordingUsage,
  ) {
    this.snapshots = new RecordingSnapshots(join(directory, "snapshots"), {
      streamId: metadata.id,
      revision: metadata.revision,
    });
  }
  static async open(
    directory: string,
    barrier?: WriteBarrier,
    usage?: RecordingUsage,
  ): Promise<RecordingSession> {
    const metadata = sessionMetadataSchema.parse(
      JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")),
    );
    const log = await JsonlLog.open(join(directory, "events.jsonl"), {
      parse: (value) => storedEventSchema.parse(value),
    });
    let blobs: BlobStore;
    try {
      blobs = await BlobStore.open(join(directory, "attachments"));
    } catch (error) {
      await log.close();
      throw error;
    }
    const session = new RecordingSession(
      directory,
      metadata,
      log,
      blobs,
      barrier,
      usage,
    );
    try {
      const verified = new Map<string, number>();
      for await (const record of log.read()) {
        if (record.sequence !== record.value.serverSeq)
          throw new ProtocolError(
            "corrupt_storage",
            "Stored sequence disagrees with log sequence",
          );
        if (record.value.content.kind === "attachment.available") {
          const attachment = record.value.content.payload.attachment;
          const size = verified.get(attachment.hash);
          if (size !== undefined && size !== attachment.byteSize)
            throw new ProtocolError(
              "corrupt_storage",
              "Inconsistent recorded attachment size",
            );
          if (size === undefined) {
            await blobs.verify(attachment);
            verified.set(attachment.hash, attachment.byteSize);
          }
        }
        session.applyCommitted(record.value, true);
      }
      if (log.boundary.sequence === 0)
        throw new ProtocolError(
          "corrupt_storage",
          "Recording has no creation record",
        );
      return session;
    } catch (error) {
      await blobs.close();
      await log.close();
      throw error;
    }
  }
  get info(): Omit<
    SessionMetadata,
    | "secretHash"
    | "creationDigest"
    | "creationRequestId"
    | "publisherCredential"
    | "visibilityChange"
    | "removed"
  > & {
    lifecycle: "open" | "ended";
    serverSeq: number;
    timelineMs: number;
    lifecycleSeq: number;
  } {
    const {
      secretHash: _,
      creationDigest: __,
      creationRequestId: ___,
      publisherCredential: ____,
      visibilityChange: _____,
      removed: ______,
      ...publicMetadata
    } = this.metadata;
    return {
      ...publicMetadata,
      ...(publicMetadata.archiveOrigin
        ? { archiveOrigin: { ...publicMetadata.archiveOrigin } }
        : {}),
      ...(publicMetadata.migrationOrigin
        ? { migrationOrigin: structuredClone(publicMetadata.migrationOrigin) }
        : {}),
      lifecycle: this.state,
      serverSeq: this.log.boundary.sequence,
      timelineMs: this.timeline,
      lifecycleSeq: this.appliedLifecycle,
    };
  }
  get boundary(): LogBoundary {
    return this.log.boundary;
  }
  /** Quota-counted durable bytes: committed event log plus installed attachments. */
  get storedBytes(): number {
    return this.log.boundary.byteOffset + this.blobs.usage.storedBytes;
  }
  buildSnapshot(through: number, signal?: AbortSignal) {
    this.snapshotBoundary(through);
    return this.snapshots.build(
      through,
      (after) => this.history(after, through),
      signal,
    );
  }
  selectSnapshot(through: number, signal?: AbortSignal, timelineMs?: number) {
    this.snapshotBoundary(through);
    return this.snapshots.select(through, signal, timelineMs);
  }
  selectSnapshotLeased(
    through: number,
    signal?: AbortSignal,
    timelineMs?: number,
  ) {
    this.snapshotBoundary(through);
    return this.snapshots.selectLeased(through, signal, timelineMs);
  }
  renewSnapshotLease(token: string, signal?: AbortSignal) {
    this.snapshotBoundary(0);
    return this.snapshots.renewLease(token, signal);
  }
  releaseSnapshotLease(token: string, signal?: AbortSignal) {
    this.snapshotBoundary(0);
    return this.snapshots.releaseLease(token, signal);
  }
  readSnapshotContent(
    ref: ContentReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
    lease?: string,
  ) {
    this.snapshotBoundary(0);
    return this.snapshots.read(ref, offset, length, signal, lease);
  }
  readSnapshotBlob(
    ref: ContentReference,
    signal?: AbortSignal,
    lease?: string,
  ) {
    this.snapshotBoundary(0);
    return this.snapshots.readBlob(ref, signal, lease);
  }
  private snapshotBoundary(through: number) {
    this.assertAvailable();
    if (this.closing)
      throw new ProtocolError("stream_gone", "Session is closing");
    if (
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through > this.boundary.sequence
    )
      throw new ProtocolError(
        "invalid_request",
        "Invalid snapshot history boundary",
      );
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }
  authorize(secret: string): void {
    this.assertAvailable();
    const actual = Buffer.from(sha256(secret), "hex");
    const expected = Buffer.from(this.metadata.secretHash, "hex");
    if (
      this.metadata.publisherCredential?.revoked ||
      !timingSafeEqual(actual, expected)
    )
      throw new ProtocolError(
        "unauthorized",
        "Invalid stream publishing credential",
      );
  }
  get publisherCredentialState() {
    return {
      streamId: this.metadata.id,
      revision: this.metadata.revision,
      publisherId: this.metadata.publisherId,
      producerEpoch: this.metadata.producerEpoch,
      version: this.metadata.publisherCredential?.version ?? 0,
      revoked: this.metadata.publisherCredential?.revoked ?? false,
    };
  }
  /** Owner authorization is enforced by the API. CAS prevents stale retries from restoring access. */
  changePublisherCredential(input: {
    operationId: string;
    revision: string;
    expectedVersion: number;
    replacementSecret: string | null;
  }) {
    const parsed = z
      .strictObject({
        operationId: idSchema,
        revision: idSchema,
        expectedVersion: cursorSchema,
        replacementSecret: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .parse(input);
    return this.mutate(async () => {
      if (parsed.revision !== this.metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      const digest = sha256(canonicalJson(parsed));
      const previous = this.metadata.publisherCredential;
      if (previous?.operationId === parsed.operationId) {
        if (previous.digest !== digest)
          throw new ProtocolError(
            "event_conflict",
            "Credential operation changed",
          );
        return this.publisherCredentialState;
      }
      if (parsed.expectedVersion !== (previous?.version ?? 0))
        throw new ProtocolError(
          "precondition_failed",
          "Publisher credential version changed",
        );
      const version = parsed.expectedVersion + 1;
      const generation = this.metadata.leaseGeneration + 1;
      if (!Number.isSafeInteger(version) || !Number.isSafeInteger(generation))
        throw new ProtocolError(
          "storage_failed",
          "Credential sequence exhausted",
        );
      if (
        parsed.replacementSecret !== null &&
        sha256(parsed.replacementSecret) === this.metadata.secretHash
      )
        throw new ProtocolError(
          "invalid_request",
          "Replacement credential must differ",
        );
      await this.save({
        ...this.metadata,
        secretHash:
          parsed.replacementSecret === null
            ? this.metadata.secretHash
            : sha256(parsed.replacementSecret),
        leaseGeneration: generation,
        publisherCredential: {
          version,
          revoked: parsed.replacementSecret === null,
          operationId: parsed.operationId,
          digest,
        },
      });
      this.lease = null;
      return this.publisherCredentialState;
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("stream_gone", "Session is closing"),
      );
    const run = this.queue.then(() => {
      this.assertAvailable();
      return operation();
    });
    this.queue = run.catch(() => {});
    return run;
  }
  /** Durable mutations wait while an online backup holds the server write barrier. */
  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return this.barrier ? this.barrier.shared(operation) : operation();
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.guard(() => this.serial(operation));
  }
  private async save(metadata: SessionMetadata): Promise<void> {
    await atomicJson(join(this.directory, "metadata.json"), metadata);
    this.metadata = metadata;
  }
  private ack(): PublisherAck {
    return {
      producerEpoch: this.metadata.producerEpoch,
      throughProducerSeq: this.producerThrough,
      serverSeq: this.producerServerSeq,
      revision: this.metadata.revision,
    };
  }
  async resume(
    secret: string,
    input: {
      publisherId: string;
      producerEpoch: string;
      attempt: number;
      revision: string;
    },
  ): Promise<{ lease: Lease; ack: PublisherAck }> {
    this.authorize(secret);
    return this.mutate(async () => {
      this.authorize(secret);
      if (input.revision !== this.metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      if (
        input.publisherId !== this.metadata.publisherId ||
        input.producerEpoch !== this.metadata.producerEpoch
      )
        throw new ProtocolError(
          "publisher_busy",
          "Explicit publisher handoff is required",
        );
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
        throw new ProtocolError(
          "invalid_request",
          "Invalid connection attempt",
        );
      if (input.attempt < this.metadata.lastAttempt)
        throw new ProtocolError(
          "stale_lease",
          "A newer publisher connection exists",
        );
      if (this.state === "ended")
        throw new ProtocolError(
          "recording_ended",
          "Explicitly reopen the recording before publishing",
        );
      if (!this.lease || input.attempt > this.metadata.lastAttempt) {
        const generation = this.metadata.leaseGeneration + 1;
        if (!Number.isSafeInteger(generation))
          throw new ProtocolError("storage_failed", "Lease sequence exhausted");
        await this.save({
          ...this.metadata,
          lastAttempt: input.attempt,
          leaseGeneration: generation,
        });
        this.lease = {
          publisherId: input.publisherId,
          producerEpoch: input.producerEpoch,
          generation,
          attempt: input.attempt,
        };
      }
      return { lease: { ...this.lease! }, ack: this.ack() };
    });
  }
  private checkLease(lease: Lease): void {
    if (!this.lease || canonicalJson(lease) !== canonicalJson(this.lease))
      throw new ProtocolError(
        "stale_lease",
        "Publisher connection was superseded",
      );
    if (this.state === "ended")
      throw new ProtocolError("recording_ended", "Recording is ended");
  }
  append(
    lease: Lease,
    input: readonly PublishedEvent[],
  ): Promise<PublisherAck> {
    let events: PublishedEvent[];
    try {
      if (
        input.length > 100 ||
        Buffer.byteLength(canonicalJson(input)) > 256 * 1024
      )
        throw new ProtocolError(
          "invalid_request",
          "Publish batch exceeds limits",
        );
      events = input.map((value) =>
        publishedEventSchema.parse(JSON.parse(canonicalJson(value))),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutate(async () => {
      this.checkLease(lease);
      let expected = this.producerThrough + 1;
      let nextServer = this.log.boundary.sequence;
      let timeline = this.timeline;
      const segments = new Map(
        [...this.segments].map(([key, value]) => [key, { ...value }]),
      );
      const additions: StoredEvent[] = [];
      const versions = new Map(
        [...this.attachmentVersions].map(([id, entries]) => [
          id,
          new Map(entries),
        ]),
      );
      const verified = new Map<string, number>();
      const retries = new Map<number, string>();
      for (const event of events)
        if (event.producerSeq <= this.producerThrough)
          retries.set(event.producerSeq, sha256(canonicalJson(event)));
      if (retries.size) {
        for await (const record of this.log.read())
          if (record.value.origin.type === "publisher") {
            const original = record.value.origin;
            const wanted = retries.get(original.event.producerSeq);
            if (wanted !== undefined) {
              if (wanted !== original.digest)
                throw new ProtocolError(
                  "event_conflict",
                  "Retry changed a committed event",
                );
              retries.delete(original.event.producerSeq);
            }
          }
        if (retries.size)
          throw new ProtocolError(
            "corrupt_storage",
            "Producer cursor has no matching log record",
          );
      }
      let batchPrevious = 0;
      for (const event of events) {
        if (
          event.streamId !== this.metadata.id ||
          event.producerEpoch !== this.metadata.producerEpoch
        )
          throw new ProtocolError(
            "event_conflict",
            "Publisher event belongs to another stream or epoch",
          );
        if (event.producerSeq <= batchPrevious)
          throw new ProtocolError(
            "sequence_gap",
            "Batch must be strictly ordered",
          );
        batchPrevious = event.producerSeq;
        if (event.producerSeq < this.producerThrough + 1) continue;
        if (event.producerSeq !== expected)
          throw new ProtocolError(
            "sequence_gap",
            "Publisher sequence is missing",
            { expected },
          );
        expected++;
        if (event.content.kind === "attachment.available") {
          const attachment = event.content.payload.attachment;
          const previous =
            versions.get(attachment.artifactId) ??
            new Map<number, BlobDescriptor>();
          if (attachment.version !== previous.size + 1)
            throw new ProtocolError(
              "event_conflict",
              "Artifact versions must be immutable and contiguous",
            );
          const size = verified.get(attachment.hash);
          if (size !== undefined && size !== attachment.byteSize)
            throw new ProtocolError(
              "event_conflict",
              "Inconsistent attachment size",
            );
          if (size === undefined) {
            await this.blobs.verify(attachment);
            verified.set(attachment.hash, attachment.byteSize);
          }
          previous.set(attachment.version, {
            hash: attachment.hash,
            byteSize: attachment.byteSize,
          });
          versions.set(attachment.artifactId, previous);
        }
        if (
          event.content.kind === "reference.resolved" ||
          (event.content.kind === "plan.updated" &&
            event.content.payload.attachment)
        ) {
          const reference =
            event.content.kind === "reference.resolved"
              ? event.content.payload
              : event.content.payload.attachment!;
          if (!versions.get(reference.artifactId)?.has(reference.version))
            throw new ProtocolError(
              "precondition_failed",
              "Reference points to an unavailable artifact version",
            );
        }
        const segment = segments.get(event.clockSegmentId);
        if (segment) {
          if (event.elapsedMs < segment.lastElapsedMs)
            throw new ProtocolError(
              "event_conflict",
              "Capture clock moved backward within a segment",
            );
          timeline = Math.max(
            timeline,
            segment.timelineMs + event.elapsedMs - segment.elapsedMs,
          );
          segment.lastElapsedMs = event.elapsedMs;
        } else {
          timeline = Math.max(
            timeline,
            Date.parse(event.observedAt) - Date.parse(this.metadata.createdAt),
            0,
          );
          segments.set(event.clockSegmentId, {
            elapsedMs: event.elapsedMs,
            timelineMs: timeline,
            lastElapsedMs: event.elapsedMs,
          });
        }
        additions.push({
          protocolVersion: 1,
          serverSeq: ++nextServer,
          receivedAt: new Date().toISOString(),
          timelineMs: timeline,
          content: event.content,
          origin: {
            type: "publisher",
            event,
            digest: sha256(canonicalJson(event)),
          },
        });
      }
      // Admit the batch against the account byte quota before writing. The estimate
      // bounds each log line (event plus sequence/hash envelope); the commit records
      // the exact committed growth. Pure retries add nothing and are always accepted.
      const reservation = additions.length
        ? this.usage?.reserveBytes(
            additions.reduce(
              (total, event) =>
                total + Buffer.byteLength(canonicalJson(event)) + 256,
              0,
            ),
          )
        : undefined;
      const before = this.log.boundary.byteOffset;
      try {
        await this.log.append(additions);
      } finally {
        // A failed append leaves the committed boundary unchanged (recovery truncates).
        reservation?.commit(this.log.boundary.byteOffset - before);
      }
      for (const event of additions) {
        this.applyCommitted(event, false);
        this.broadcast(event);
      }
      return this.ack();
    });
  }
  private applyCommitted(event: StoredEvent, recovering: boolean): void {
    if (event.timelineMs < this.timeline)
      throw new ProtocolError(
        "corrupt_storage",
        "Recording timeline moved backward",
      );
    this.timeline = event.timelineMs;
    if (event.content.kind === "attachment.available") {
      const attachment = event.content.payload.attachment;
      const versions =
        this.attachmentVersions.get(attachment.artifactId) ??
        new Map<number, BlobDescriptor>();
      if (attachment.version !== versions.size + 1)
        throw new ProtocolError(
          "corrupt_storage",
          "Invalid recorded artifact version",
        );
      versions.set(attachment.version, {
        hash: attachment.hash,
        byteSize: attachment.byteSize,
      });
      this.attachmentVersions.set(attachment.artifactId, versions);
      this.referencedBlobs.add(attachment.hash);
    }
    if (
      event.content.kind === "reference.resolved" ||
      (event.content.kind === "plan.updated" &&
        event.content.payload.attachment)
    ) {
      const reference =
        event.content.kind === "reference.resolved"
          ? event.content.payload
          : event.content.payload.attachment!;
      if (
        !this.attachmentVersions
          .get(reference.artifactId)
          ?.has(reference.version)
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Recorded reference has no artifact version",
        );
    }
    if (event.origin.type === "publisher") {
      const published = event.origin.event;
      if (
        published.producerEpoch !== this.metadata.producerEpoch ||
        published.producerSeq !== this.producerThrough + 1 ||
        published.streamId !== this.metadata.id ||
        event.origin.digest !== sha256(canonicalJson(published)) ||
        canonicalJson(event.content) !== canonicalJson(published.content)
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Invalid durable publisher prefix",
        );
      this.producerThrough = published.producerSeq;
      this.producerServerSeq = event.serverSeq;
      const segment = this.segments.get(published.clockSegmentId);
      if (segment) {
        if (published.elapsedMs < segment.lastElapsedMs)
          throw new ProtocolError("corrupt_storage", "Invalid capture clock");
        segment.lastElapsedMs = published.elapsedMs;
      } else
        this.segments.set(published.clockSegmentId, {
          elapsedMs: published.elapsedMs,
          timelineMs: event.timelineMs,
          lastElapsedMs: published.elapsedMs,
        });
    } else {
      const operationId = event.origin.operationId;
      const digest = sha256(canonicalJson(event.content));
      if (this.operations.has(operationId))
        throw new ProtocolError(
          "corrupt_storage",
          "Duplicate lifecycle operation",
        );
      this.operations.set(operationId, {
        digest,
        result: structuredClone(event),
      });
      if (event.content.kind === "recording.ended") {
        this.state = "ended";
        this.appliedLifecycle = event.serverSeq;
        this.lease = null;
      } else if (
        event.content.kind === "recording.created" ||
        event.content.kind === "recording.reopened"
      ) {
        this.state = "open";
        this.appliedLifecycle = event.serverSeq;
      } else if (recovering)
        throw new ProtocolError(
          "version_unsupported",
          "Unsupported server lifecycle event",
        );
    }
  }
  private broadcast(event: StoredEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.deliver(structuredClone(event));
      } catch {
        this.subscribers.delete(subscriber);
        try {
          subscriber.invalidate("delivery_failed");
        } catch {}
      }
    }
  }
  async uploadAttachment(
    secret: string,
    descriptor: BlobDescriptor,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<BlobDescriptor> {
    this.authorize(secret);
    if (this.closing)
      throw new ProtocolError("stream_gone", "Session is closing");
    // Reserve the declared size before reading any body bytes; an already
    // installed (deduplicated) blob commits zero new bytes.
    const reservation =
      Number.isSafeInteger(descriptor.byteSize) && descriptor.byteSize >= 0
        ? this.usage?.reserveBytes(descriptor.byteSize)
        : undefined;
    try {
      const staged = await this.blobs.stage(descriptor, source, signal);
      try {
        return await this.mutate(async () => {
          this.authorize(secret);
          const before = this.blobs.usage.storedBytes;
          try {
            return await this.blobs.install(staged);
          } finally {
            reservation?.commit(this.blobs.usage.storedBytes - before);
          }
        });
      } finally {
        await this.blobs.discard(staged);
      }
    } finally {
      reservation?.release();
    }
  }
  async attachmentStatus(
    secret: string,
    descriptor: BlobDescriptor,
  ): Promise<boolean> {
    this.authorize(secret);
    return this.serial(async () => {
      this.authorize(secret);
      try {
        await this.blobs.verify(descriptor);
        return true;
      } catch (error) {
        if (
          error instanceof ProtocolError &&
          error.code === "precondition_failed"
        )
          return false;
        throw error;
      }
    });
  }
  /** Authorization is performed by the API; unannounced uploaded bytes are never viewer-visible. */
  openAttachment(hash: string): Promise<import("node:fs/promises").FileHandle> {
    return this.serial(async () => {
      if (!this.referencedBlobs.has(hash))
        throw new ProtocolError(
          "precondition_failed",
          "Attachment has not been published",
        );
      return this.blobs.openFile(hash);
    });
  }
  collectUnreferencedAttachments(olderThan: number): Promise<number> {
    if (!Number.isFinite(olderThan))
      return Promise.reject(
        new ProtocolError("invalid_request", "Invalid collection cutoff"),
      );
    return this.mutate(async () => {
      const before = this.blobs.usage.storedBytes;
      try {
        return await this.blobs.collect(this.referencedBlobs, olderThan);
      } finally {
        this.usage?.adjustBytes(this.blobs.usage.storedBytes - before);
      }
    });
  }
  subscribe(subscriber: Subscriber): Promise<{
    boundary: LogBoundary;
    revision: string;
    unsubscribe: () => void;
  }> {
    return this.serial(async () => {
      this.subscribers.add(subscriber);
      return {
        boundary: this.log.boundary,
        revision: this.metadata.revision,
        unsubscribe: () => {
          this.subscribers.delete(subscriber);
        },
      };
    });
  }
  async *history(after: number, through: number): AsyncGenerator<StoredEvent> {
    this.assertAvailable();
    for await (const record of this.log.read(after, through)) {
      this.assertAvailable();
      yield record.value;
    }
  }
  /** Freeze export metadata at the same serialized boundary as publication. */
  exportBoundary() {
    return this.serial(async () => structuredClone(this.info));
  }
  lifecycle(
    secret: string,
    operationId: string,
    expectedLifecycleSeq: number,
    content: Extract<
      EventContent,
      { kind: "recording.ended" | "recording.reopened" }
    >,
  ): Promise<StoredEvent> {
    this.authorize(secret);
    idSchema.parse(operationId);
    return this.mutate(async () => {
      this.authorize(secret);
      const digest = sha256(canonicalJson(content));
      const existing = this.operations.get(operationId);
      if (existing) {
        if (existing.digest !== digest)
          throw new ProtocolError(
            "event_conflict",
            "Lifecycle retry changed content",
          );
        return structuredClone(existing.result);
      }
      if (expectedLifecycleSeq !== this.appliedLifecycle)
        throw new ProtocolError(
          "precondition_failed",
          "Lifecycle state changed",
          { lifecycleSeq: this.appliedLifecycle },
        );
      if (content.kind === "recording.ended") {
        if (
          this.state !== "open" ||
          content.payload.producerEpoch !== this.metadata.producerEpoch ||
          content.payload.throughProducerSeq !== this.producerThrough
        )
          throw new ProtocolError(
            "precondition_failed",
            "Finish requires the exact durable producer prefix",
          );
      } else if (this.state !== "ended")
        throw new ProtocolError(
          "precondition_failed",
          "Recording is already open",
        );
      const record: StoredEvent = {
        protocolVersion: 1,
        serverSeq: this.log.boundary.sequence + 1,
        receivedAt: new Date().toISOString(),
        timelineMs: this.timeline,
        content,
        origin: { type: "server", operationId },
      };
      // Ending is never quota-limited; reopening counts against open recordings.
      // Lifecycle records are small and always counted toward stored bytes.
      const active =
        content.kind === "recording.reopened"
          ? this.usage?.reserveActive()
          : undefined;
      const before = this.log.boundary.byteOffset;
      try {
        await this.log.append([record]);
      } catch (error) {
        active?.release();
        throw error;
      } finally {
        this.usage?.adjustBytes(this.log.boundary.byteOffset - before);
      }
      if (content.kind === "recording.ended") this.usage?.ended();
      else active?.commit(0);
      this.applyCommitted(record, false);
      this.broadcast(record);
      return record;
    });
  }
  get visibilityState() {
    return {
      streamId: this.metadata.id,
      revision: this.metadata.revision,
      visibility: this.metadata.visibility,
      version: this.metadata.visibilityChange?.version ?? 0,
    };
  }
  get isRemoved() {
    return this.metadata.removed !== undefined;
  }
  assertAvailable() {
    if (this.migrationUncertain)
      throw new ProtocolError(
        "storage_failed",
        "Migration persistence is uncertain; reopen the store before continuing",
      );
    if (this.removalUncertain)
      throw new ProtocolError(
        "storage_failed",
        "Removal persistence is uncertain; reopen the store before continuing",
      );
    if (this.metadata.removed)
      throw new ProtocolError("stream_gone", "Recording was removed");
  }
  /** Persist an irreversible service tombstone before cancelling active access. */
  remove(operationId: string, revision: string, expectedServerSeq?: number) {
    idSchema.parse(operationId);
    idSchema.parse(revision);
    if (expectedServerSeq !== undefined) cursorSchema.parse(expectedServerSeq);
    return this.guard(() =>
      this.removeQueued(operationId, revision, expectedServerSeq),
    );
  }
  private removeQueued(
    operationId: string,
    revision: string,
    expectedServerSeq?: number,
  ) {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("stream_gone", "Session is closing"),
      );
    const run = this.queue.then(async () => {
      if (revision !== this.metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      if (!this.metadata.removed) {
        if (
          expectedServerSeq !== undefined &&
          (this.state !== "ended" ||
            this.log.boundary.sequence !== expectedServerSeq)
        )
          throw new ProtocolError(
            "precondition_failed",
            "Recording changed after migration export",
          );
        if (this.removalUncertain || this.migrationUncertain)
          this.assertAvailable();
        try {
          await this.save({
            ...this.metadata,
            removed: { operationId, removedAt: Date.now() },
          });
        } catch (error) {
          // Atomic replacement can succeed before its directory sync fails.
          // Do not continue serving from the stale in-memory metadata.
          this.removalUncertain = true;
          this.lease = null;
          this.cancelPublicReads();
          this.cancelReads();
          for (const subscriber of this.subscribers) {
            try {
              subscriber.invalidate("removal_uncertain");
            } catch {}
          }
          this.subscribers.clear();
          throw error;
        }
        this.lease = null;
        this.cancelPublicReads();
        this.cancelReads();
        for (const subscriber of this.subscribers) {
          try {
            subscriber.invalidate("recording_removed");
          } catch {}
        }
        this.subscribers.clear();
      }
      return {
        streamId: this.metadata.id,
        removed: true,
        removedAt: this.metadata.removed!.removedAt,
      };
    });
    this.queue = run.catch(() => {});
    return run;
  }
  /** Immutable lineage, committed before migration may remove its source. */
  setMigrationOrigin(revision: string, value: MigrationOrigin) {
    idSchema.parse(revision);
    const origin = migrationOriginSchema.parse(value);
    return this.mutate(async () => {
      if (revision !== this.metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      if (this.metadata.migrationOrigin) {
        if (
          canonicalJson(origin) !== canonicalJson(this.metadata.migrationOrigin)
        )
          throw new ProtocolError(
            "event_conflict",
            "Migration lineage is immutable",
          );
        return structuredClone(this.metadata.migrationOrigin);
      }
      if (
        (!origin.externalSource &&
          origin.sourceStreamId === this.metadata.id) ||
        this.state !== "ended" ||
        this.metadata.visibility !== "private"
      )
        throw new ProtocolError(
          "precondition_failed",
          "Migration lineage requires a private ended replacement",
        );
      try {
        await this.save({ ...this.metadata, migrationOrigin: origin });
      } catch (error) {
        this.migrationUncertain = true;
        throw error;
      }
      return structuredClone(origin);
    });
  }
  changeVisibility(input: {
    revision: string;
    operationId: string;
    expectedVersion: number;
    visibility: "public" | "unlisted" | "private";
  }) {
    const parsed = z
      .strictObject({
        revision: idSchema,
        operationId: idSchema,
        expectedVersion: cursorSchema,
        visibility: z.enum(["public", "unlisted", "private"]),
      })
      .parse(input);
    return this.mutate(async () => {
      if (parsed.revision !== this.metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      const previous = this.metadata.visibilityChange;
      const digest = sha256(canonicalJson(parsed));
      if (previous?.operationId === parsed.operationId) {
        if (previous.digest !== digest)
          throw new ProtocolError(
            "event_conflict",
            "Visibility operation changed",
          );
        return this.visibilityState;
      }
      if ((previous?.version ?? 0) !== parsed.expectedVersion)
        throw new ProtocolError(
          "precondition_failed",
          "Visibility version changed",
        );
      const version = parsed.expectedVersion + 1;
      if (!Number.isSafeInteger(version))
        throw new ProtocolError(
          "storage_failed",
          "Visibility sequence exhausted",
        );
      await this.save({
        ...this.metadata,
        visibility: parsed.visibility,
        visibilityChange: { version, operationId: parsed.operationId, digest },
      });
      if (parsed.visibility === "private") this.cancelPublicReads();
      // Re-subscription rechecks current access, including previously public viewers.
      for (const subscriber of this.subscribers) {
        try {
          subscriber.invalidate("visibility_changed");
        } catch {}
      }
      this.subscribers.clear();
      return this.visibilityState;
    });
  }
  /** One-way publication of an ended, initially private imported recording. */
  shareEnded(visibility: "public" | "unlisted" | "private"): Promise<void> {
    return this.mutate(async () => {
      if (this.metadata.visibilityChange)
        throw new ProtocolError(
          "precondition_failed",
          "Use versioned visibility management after a visibility edit",
        );
      if (this.state !== "ended")
        throw new ProtocolError(
          "precondition_failed",
          "Finish the recording before sharing an import",
        );
      if (
        this.metadata.visibility !== "private" &&
        this.metadata.visibility !== visibility
      )
        throw new ProtocolError(
          "precondition_failed",
          "This operation cannot change an already shared recording",
        );
      if (this.metadata.visibility !== visibility)
        await this.save({ ...this.metadata, visibility });
    });
  }
  private closePromise: Promise<void> | undefined;
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.queue;
      this.cancelPublicReads();
      this.cancelReads();
      for (const subscriber of this.subscribers) {
        try {
          subscriber.invalidate("session_closed");
        } catch {}
      }
      this.subscribers.clear();
      const snapshotResult = await Promise.allSettled([this.snapshots.close()]);
      const results = [
        ...snapshotResult,
        ...(await Promise.allSettled([this.blobs.close(), this.log.close()])),
      ];
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Recording session cleanup failed");
    })();
    return this.closePromise;
  }
}
