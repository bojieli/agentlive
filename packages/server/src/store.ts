import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FileLock,
  JsonlLog,
  atomicJson,
  syncDirectory,
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
  ) {}
  static async open(
    directory: string,
    options: { maxCachedSessions?: number } = {},
  ): Promise<RecordingStore> {
    const maximum = options.maxCachedSessions ?? 128;
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new RangeError("Invalid session cache capacity");
    const lock = await FileLock.acquire(join(directory, ".server.lock"));
    try {
      await mkdir(join(directory, "sessions"), {
        recursive: true,
        mode: 0o700,
      });
      const store = new RecordingStore(directory, lock, maximum);
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
        store.requests.set(key, {
          id: metadata.id,
          digest: metadata.creationDigest,
        });
      }
      return store;
    } catch (error) {
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
  create(raw: CreateSession): Promise<RecordingSession> {
    let request: CreateSession;
    try {
      request = createSessionSchema.parse(raw);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.serial(async () => {
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
  private async load(id: string): Promise<RecordingSession> {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.users++;
      existing.touched = ++this.clock;
      return existing.session;
    }
    await this.makeRoom();
    try {
      const session = await RecordingSession.open(
        join(this.directory, "sessions", id),
      );
      this.sessions.set(id, { session, users: 1, touched: ++this.clock });
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
      await entry.session.close();
    } catch (error) {
      this.closed = true;
      throw error;
    }
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
