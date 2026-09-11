import { Reports } from "./reports.js";
import { ensureDataFormat } from "./data-format.js";
import { WriteBarrier } from "./write-barrier.js";
import { cleanRemovedStorage } from "./removed-storage.js";
import {
  SnapshotScheduler,
  type SnapshotScheduleOptions,
} from "./snapshot-scheduler.js";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  FileLock,
  JsonlLog,
  atomicJson,
  syncDirectory,
  BlobStore,
  type OpenArchive,
} from "@agentlive/storage";
import {
  canonicalJson,
  idSchema,
  storedEventSchema,
  ProtocolError,
  type StoredEvent,
} from "@agentlive/protocol";
import {
  RecordingSession,
  sessionMetadataSchema,
  sha256,
  type SessionMetadata,
} from "./session.js";
export const createSessionSchema = z.strictObject({
  ownerId: idSchema,
  requestId: idSchema,
  requestedAt: z.iso.datetime(),
  publisherId: idSchema,
  producerEpoch: idSchema,
  writeSecret: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(500),
  visibility: z.enum(["public", "unlisted", "private"]),
});
export type CreateSession = z.infer<typeof createSessionSchema>;
export class RecordingStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly requests = new Map<string, { id: string; digest: string }>();
  private readonly sessions = new Map<
    string,
    { session: RecordingSession; users: number; touched: number }
  >();
  private clock = 0;
  private constructor(
    readonly directory: string,
    private readonly lock: FileLock,
    private readonly maximum: number,
    private readonly snapshotScheduler: SnapshotScheduler,
    readonly reports: Reports,
    /** Shared by every durable writer of this server directory (online backup). */
    readonly barrier: WriteBarrier,
  ) {}
  static async open(
    directory: string,
    options: {
      maxCachedSessions?: number;
      snapshots?: SnapshotScheduleOptions;
    } = {},
  ): Promise<RecordingStore> {
    const maximum = options.maxCachedSessions ?? 128;
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new RangeError("Invalid session cache capacity");
    const scheduler = new SnapshotScheduler(options.snapshots);
    const lock = await FileLock.acquire(join(directory, ".server.lock"));
    try {
      try {
        await readFile(join(directory, ".restore-in-progress"));
        throw new Error(
          "Restore is incomplete; use a new destination and retry restore",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await ensureDataFormat(directory);
      await mkdir(join(directory, "sessions"), {
        recursive: true,
        mode: 0o700,
      });
      const barrier = new WriteBarrier();
      const reports = await Reports.open(
        join(directory, "reports.json"),
        barrier,
      );
      const store = new RecordingStore(
        directory,
        lock,
        maximum,
        scheduler,
        reports,
        barrier,
      );
      for (const entry of await readdir(join(directory, "sessions"), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory()) continue;
        idSchema.parse(entry.name);
        const metadata = sessionMetadataSchema.parse(
          JSON.parse(
            await readFile(
              join(directory, "sessions", entry.name, "metadata.json"),
              "utf8",
            ),
          ),
        );
        if (metadata.id !== entry.name)
          throw new ProtocolError(
            "corrupt_storage",
            "Session directory identity mismatch",
          );
        const key = canonicalJson([
          metadata.ownerId,
          metadata.creationRequestId,
        ]);
        if (store.requests.has(key))
          throw new ProtocolError(
            "corrupt_storage",
            "Duplicate session creation request",
          );
        if (metadata.removed)
          await cleanRemovedStorage(join(directory, "sessions", entry.name));
        store.requests.set(key, {
          id: metadata.id,
          digest: metadata.creationDigest,
        });
      }
      return store;
    } catch (error) {
      await scheduler.close();
      await lock.release();
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new ProtocolError("storage_failed", "Server store is closed"),
      );
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  /** Durable store mutations wait while an online backup holds the barrier. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.barrier.shared(() => this.serial(operation));
  }
  list(options: { ownerId: string; after?: string; limit?: number }) {
    const ownerId = idSchema.parse(options.ownerId);
    const after =
      options.after === undefined ? undefined : idSchema.parse(options.after);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ProtocolError(
        "invalid_request",
        "Listing limit must be from 1 to 100",
      );
    return this.serial(async () => {
      // Bound page selection memory even when the creation-request index is large.
      const selected: string[] = [];
      for (const [key, value] of this.requests) {
        if (
          JSON.parse(key)[0] !== ownerId ||
          (after !== undefined && value.id <= after)
        )
          continue;
        if (
          selected.length === limit + 1 &&
          value.id >= selected[selected.length - 1]!
        )
          continue;
        const metadata = sessionMetadataSchema.parse(
          JSON.parse(
            await readFile(
              join(this.directory, "sessions", value.id, "metadata.json"),
              "utf8",
            ),
          ),
        );
        if (metadata.id !== value.id || metadata.ownerId !== ownerId)
          throw new ProtocolError(
            "corrupt_storage",
            "Recording listing identity mismatch",
          );
        if (metadata.removed) continue;
        selected.push(value.id);
        selected.sort();
        if (selected.length > limit + 1) selected.pop();
      }
      const more = selected.length > limit;
      if (more) selected.pop();
      const recordings = [];
      for (const id of selected) {
        const metadata = sessionMetadataSchema.parse(
          JSON.parse(
            await readFile(
              join(this.directory, "sessions", id, "metadata.json"),
              "utf8",
            ),
          ),
        );
        if (metadata.id !== id || metadata.ownerId !== ownerId)
          throw new ProtocolError(
            "corrupt_storage",
            "Recording listing identity mismatch",
          );
        recordings.push({
          id,
          revision: metadata.revision,
          title: metadata.title,
          visibility: metadata.visibility,
          createdAt: metadata.createdAt,
        });
      }
      return {
        recordings,
        nextAfter: more ? selected[selected.length - 1]! : null,
      };
    });
  }
  listPublic(
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    const after =
      options.after === undefined ? undefined : idSchema.parse(options.after);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ProtocolError(
        "invalid_request",
        "Listing limit must be from 1 to 100",
      );
    return this.serial(async () => {
      const selected: {
        id: string;
        revision: string;
        title: string;
        visibility: "public";
        createdAt: string;
      }[] = [];
      for (const value of this.requests.values()) {
        options.signal?.throwIfAborted();
        if (
          (after !== undefined && value.id <= after) ||
          (selected.length > limit &&
            value.id >= selected[selected.length - 1]!.id)
        )
          continue;
        const metadata = sessionMetadataSchema.parse(
          JSON.parse(
            await readFile(
              join(this.directory, "sessions", value.id, "metadata.json"),
              "utf8",
            ),
          ),
        );
        if (metadata.id !== value.id)
          throw new ProtocolError(
            "corrupt_storage",
            "Recording listing identity mismatch",
          );
        if (metadata.removed || metadata.visibility !== "public") continue;
        selected.push({
          id: metadata.id,
          revision: metadata.revision,
          title: metadata.title,
          visibility: "public",
          createdAt: metadata.createdAt,
        });
        selected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (selected.length > limit + 1) selected.pop();
      }
      const more = selected.length > limit;
      if (more) selected.pop();
      return {
        recordings: selected,
        nextAfter: more ? selected[selected.length - 1]!.id : null,
      };
    });
  }
  create(raw: CreateSession): Promise<RecordingSession> {
    let request: CreateSession;
    try {
      request = createSessionSchema.parse(raw);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutate(async () => {
      const { writeSecret, ...parameters } = request;
      const digest = sha256(
        canonicalJson({ ...parameters, secretHash: sha256(writeSecret) }),
      );
      const key = canonicalJson([request.ownerId, request.requestId]);
      const existing = this.requests.get(key);
      if (existing) {
        if (existing.digest !== digest)
          throw new ProtocolError(
            "event_conflict",
            "Session creation request was reused with different parameters",
          );
        return this.load(existing.id);
      }
      const age = Date.now() - Date.parse(request.requestedAt);
      if (age > 24 * 60 * 60 * 1000 || age < -5 * 60 * 1000)
        throw new ProtocolError(
          "precondition_failed",
          "New creation request timestamp is outside its acceptance window",
        );
      await this.makeRoom();
      const id = randomUUID();
      const directory = join(this.directory, "sessions", id);
      const temporary = join(
        this.directory,
        "sessions",
        `.creating-${randomUUID()}`,
      );
      const metadata: SessionMetadata = {
        version: 1,
        id,
        revision: randomUUID(),
        ownerId: request.ownerId,
        title: request.title,
        visibility: request.visibility,
        createdAt: new Date().toISOString(),
        creationRequestId: request.requestId,
        creationDigest: digest,
        secretHash: sha256(writeSecret),
        publisherId: request.publisherId,
        producerEpoch: request.producerEpoch,
        leaseGeneration: 0,
        lastAttempt: 0,
      };
      await mkdir(temporary, { mode: 0o700 });
      let installed = false;
      try {
        await atomicJson(join(temporary, "metadata.json"), metadata);
        const log = await JsonlLog.open(join(temporary, "events.jsonl"), {
          parse: (value) => storedEventSchema.parse(value),
        });
        try {
          const first: StoredEvent = {
            protocolVersion: 1,
            serverSeq: 1,
            receivedAt: metadata.createdAt,
            timelineMs: 0,
            content: {
              kind: "recording.created",
              payload: { title: request.title },
            },
            origin: { type: "server", operationId: request.requestId },
          };
          await log.append([first]);
        } finally {
          await log.close();
        }
        await syncDirectory(temporary);
        await rename(temporary, directory);
        installed = true;
        await syncDirectory(join(this.directory, "sessions"));
      } catch (error) {
        // A directory-sync failure after rename has an uncertain durability result.
        // Reopen/rebuild the request index before accepting another create retry.
        if (installed) this.closed = true;
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      this.requests.set(key, { id, digest });
      return this.load(id);
    });
  }
  /** Install a verified portable recording under a new private identity. */
  importArchive(
    archive: OpenArchive,
    ownerId: string,
    signal: AbortSignal,
    importRequestId?: string,
  ): Promise<RecordingSession> {
    idSchema.parse(ownerId);
    if (importRequestId !== undefined) idSchema.parse(importRequestId);
    return this.mutate(async () => {
      signal.throwIfAborted();
      const requestId = importRequestId ?? randomUUID();
      const digest = sha256(canonicalJson(archive.manifest));
      const existing = this.requests.get(canonicalJson([ownerId, requestId]));
      if (existing) {
        if (existing.digest !== digest)
          throw new ProtocolError(
            "event_conflict",
            "Archive import request changed",
          );
        return this.load(existing.id);
      }
      await this.makeRoom();
      const id = randomUUID(),
        revision = randomUUID();
      const temporary = join(this.directory, "sessions", `.importing-${id}`);
      const destination = join(this.directory, "sessions", id);
      await mkdir(temporary, { mode: 0o700 });
      let installed = false;
      try {
        const blobs = await BlobStore.open(join(temporary, "attachments"));
        try {
          for (const file of archive.manifest.files) {
            if (!file.path.startsWith("attachments/")) continue;
            signal.throwIfAborted();
            const staged = await blobs.stage(
              { hash: file.hash, byteSize: file.byteSize },
              archive.attachment(file.hash),
              signal,
            );
            try {
              await blobs.install(staged);
            } finally {
              await blobs.discard(staged);
            }
          }
        } finally {
          await blobs.close();
        }
        const log = await JsonlLog.open<StoredEvent>(
          join(temporary, "events.jsonl"),
          { parse: (value) => storedEventSchema.parse(value) },
        );
        let epoch: string | undefined,
          producerThrough = 0,
          through = 0,
          timeline = 0,
          ended = false;
        try {
          let batch: StoredEvent[] = [];
          let bytes = 0;
          const flush = async () => {
            if (batch.length) await log.append(batch);
            batch = [];
            bytes = 0;
          };
          for await (const original of archive.events(signal)) {
            const event = structuredClone(original);
            if (event.origin.type === "publisher") {
              epoch ??= event.origin.event.producerEpoch;
              event.origin.event.streamId = id;
              event.origin.digest = sha256(canonicalJson(event.origin.event));
              producerThrough = event.origin.event.producerSeq;
            }
            if (event.content.kind === "recording.ended") {
              epoch ??= event.content.payload.producerEpoch;
              ended = true;
            } else if (
              event.content.kind === "recording.created" ||
              event.content.kind === "recording.reopened"
            )
              ended = false;
            const size = Buffer.byteLength(canonicalJson(event));
            if (batch.length && (batch.length >= 256 || bytes + size > 1048576))
              await flush();
            batch.push(event);
            bytes += size;
            through = event.serverSeq;
            timeline = event.timelineMs;
          }
          epoch ??= randomUUID();
          if (!ended)
            batch.push({
              protocolVersion: 1,
              serverSeq: through + 1,
              timelineMs: timeline,
              receivedAt: new Date().toISOString(),
              origin: {
                type: "server",
                operationId: `archive-end-${randomUUID()}`,
              },
              content: {
                kind: "recording.ended",
                payload: {
                  producerEpoch: epoch,
                  throughProducerSeq: producerThrough,
                },
              },
            });
          await flush();
        } finally {
          await log.close();
        }
        const metadata: SessionMetadata = {
          version: 1,
          id,
          revision,
          ownerId,
          title: archive.manifest.recording.title,
          archiveOrigin: {
            ...(archive.manifest.recording.serverOrigin
              ? { serverOrigin: archive.manifest.recording.serverOrigin }
              : {}),
            streamId: archive.manifest.recording.streamId,
            revision: archive.manifest.recording.revision,
            throughServerSeq: archive.manifest.recording.throughServerSeq,
          },
          ...(archive.manifest.provenance.migrationOrigin
            ? { migrationOrigin: archive.manifest.provenance.migrationOrigin }
            : {}),
          visibility: "private",
          createdAt: archive.manifest.recording.createdAt,
          creationRequestId: requestId,
          creationDigest: sha256(canonicalJson(archive.manifest)),
          secretHash: sha256(randomBytes(32).toString("hex")),
          publisherId: randomUUID(),
          producerEpoch: epoch!,
          leaseGeneration: 0,
          lastAttempt: 0,
        };
        await atomicJson(join(temporary, "metadata.json"), metadata);
        await atomicJson(
          join(temporary, "archive-provenance.json"),
          archive.manifest,
        );
        // Validate the complete session (including publisher order, lifecycle and
        // every referenced artifact version) before making it discoverable.
        const check = await RecordingSession.open(temporary);
        try {
          if (check.info.lifecycle !== "ended")
            throw new Error("Imported recording is not ended");
        } finally {
          await check.close();
        }
        signal.throwIfAborted();
        await syncDirectory(temporary);
        await rename(temporary, destination);
        installed = true;
        await syncDirectory(join(this.directory, "sessions"));
        this.requests.set(canonicalJson([ownerId, requestId]), {
          id,
          digest: metadata.creationDigest,
        });
        return await this.load(id);
      } catch (error) {
        if (installed) this.closed = true;
        throw error;
      } finally {
        if (!installed) await rm(temporary, { recursive: true, force: true });
      }
    });
  }
  /** Owner-authorized durable removal; retained metadata fences creation retries. */
  remove(input: {
    id: string;
    revision: string;
    operationId: string;
    expectedServerSeq?: number | undefined;
    ownerId?: string;
    operator?: boolean;
  }) {
    idSchema.parse(input.id);
    idSchema.parse(input.revision);
    idSchema.parse(input.operationId);
    return this.mutate(async () => {
      let metadata: SessionMetadata;
      try {
        metadata = sessionMetadataSchema.parse(
          JSON.parse(
            await readFile(
              join(this.directory, "sessions", input.id, "metadata.json"),
              "utf8",
            ),
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new ProtocolError("stream_gone", "Recording does not exist");
        throw error;
      }
      if (metadata.id !== input.id)
        throw new ProtocolError(
          "corrupt_storage",
          "Recording identity mismatch",
        );
      if (!input.operator && input.ownerId !== metadata.ownerId)
        throw new ProtocolError(
          "unauthorized",
          "Recording owner authorization required",
        );
      if (input.revision !== metadata.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      if (metadata.removed) {
        await this.cleanRemoved(input.id);
        return {
          streamId: metadata.id,
          removed: true,
          removedAt: metadata.removed.removedAt,
        };
      }
      const session = await this.load(input.id);
      try {
        const result = await session.remove(
          input.operationId,
          input.revision,
          input.expectedServerSeq,
        );
        await this.snapshotScheduler.remove(session);
        return result;
      } finally {
        this.release(session);
        await this.cleanRemoved(input.id);
      }
    });
  }
  private async cleanRemoved(id: string) {
    const entry = this.sessions.get(id);
    if (entry) {
      if (entry.users !== 0 || !entry.session.isRemoved) return;
      await this.snapshotScheduler.remove(entry.session);
      await entry.session.close();
      this.sessions.delete(id);
    }
    await cleanRemovedStorage(join(this.directory, "sessions", id));
  }
  private async load(id: string): Promise<RecordingSession> {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.session.assertAvailable();
      existing.users++;
      existing.touched = ++this.clock;
      return existing.session;
    }
    await this.makeRoom();
    try {
      const metadata = sessionMetadataSchema.parse(
        JSON.parse(
          await readFile(
            join(this.directory, "sessions", id, "metadata.json"),
            "utf8",
          ),
        ),
      );
      if (metadata.id !== id)
        throw new ProtocolError(
          "corrupt_storage",
          "Recording identity mismatch",
        );
      if (metadata.removed)
        throw new ProtocolError("stream_gone", "Recording was removed");
      const session = await RecordingSession.open(
        join(this.directory, "sessions", id),
        this.barrier,
      );
      this.sessions.set(id, { session, users: 1, touched: ++this.clock });
      this.snapshotScheduler.add(session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ProtocolError("stream_gone", "Recording does not exist");
      throw error;
    }
  }
  private async makeRoom(): Promise<void> {
    if (this.sessions.size < this.maximum) return;
    const idle = [...this.sessions.entries()]
      .filter(([, entry]) => entry.users === 0)
      .sort(([, a], [, b]) => a.touched - b.touched)[0];
    if (!idle)
      throw new ProtocolError("retry_later", "All cached sessions are in use");
    const [id, entry] = idle;
    this.sessions.delete(id);
    try {
      await this.snapshotScheduler.remove(entry.session);
      await entry.session.close();
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  get snapshotStatus() {
    return this.snapshotScheduler.status;
  }
  get cacheSize(): number {
    return this.sessions.size;
  }
  /** Release exactly one ownership acquired by get/create; idle sessions become evictable. */
  release(session: RecordingSession): void {
    const entry = this.sessions.get(session.info.id);
    if (!entry && this.closed) return;
    if (!entry || entry.session !== session || entry.users === 0)
      throw new Error("Session ownership is not held");
    entry.users--;
    entry.touched = ++this.clock;
    if (entry.users === 0 && session.isRemoved && !this.closed)
      void this.barrier
        .detached(() => this.serial(() => this.cleanRemoved(session.info.id)))
        .catch(() => {
          // The durable intent survives cleanup errors; removal retry or restart retries.
        });
  }
  /** Caller owns the returned session until release, including across async operations. */
  get(id: string): Promise<RecordingSession> {
    idSchema.parse(id);
    return this.serial(() => this.load(id));
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.queue;
      await this.snapshotScheduler.close();
      await this.reports.close();
      const results = await Promise.allSettled(
        [...this.sessions.values()].map(({ session }) =>
          Promise.resolve().then(() => session.close()),
        ),
      );
      this.sessions.clear();
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      try {
        await this.lock.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Server store cleanup failed");
    })();
    return this.closePromise;
  }
}
