import { constants } from "node:fs";
import type { WriteBarrier } from "./write-barrier.js";
import { open } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { FileLock, atomicJson } from "@agentlive/storage";
import { canonicalJson, idSchema, ProtocolError } from "@agentlive/protocol";
const grantSchema = z.strictObject({
  id: idSchema,
  streamId: idSchema,
  revision: idSchema,
  label: z.string().max(200),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
type Grant = z.infer<typeof grantSchema>;
export type ViewingGrant = Omit<Grant, "tokenHash">;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const publicGrant = ({ tokenHash: _, ...grant }: Grant): ViewingGrant => grant;
/** Server-owned credential ledger. All writes commit before becoming visible.
 * Tokens authorize reads only; callers still enforce each HTTP/WS operation. */
export class ViewingGrants {
  private grants = new Map<string, Grant>();
  private tokens = new Map<string, Grant>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private active = new Map<string, Set<() => void>>();
  private activeCount = 0;
  private closePromise: Promise<void> | undefined;
  private listeners = new Set<(id: string) => void>();
  private constructor(
    private readonly path: string,
    private readonly lock: FileLock,
  ) {}
  /** Online backup admission gate for ledger mutations. */
  private barrier: WriteBarrier | undefined;
  static async open(path: string, barrier?: WriteBarrier) {
    const lock = await FileLock.acquire(path + ".lock");
    const store = new ViewingGrants(path, lock);
    store.barrier = barrier;
    try {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 4 * 1024 * 1024 ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Invalid viewing grant file");
        const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > 4 * 1024 * 1024)
          throw new Error("Viewing grant file exceeds limit");
        const saved = z
          .strictObject({
            version: z.literal(1),
            grants: z.array(grantSchema).max(10000),
          })
          .parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                buffer.subarray(0, length),
              ),
            ),
          );
        for (const grant of saved.grants) {
          if (
            grant.expiresAt <= grant.createdAt ||
            store.grants.has(grant.id) ||
            store.tokens.has(grant.tokenHash)
          )
            throw new Error(
              "Invalid duplicate or expired viewing grant interval",
            );
          store.grants.set(grant.id, grant);
          store.tokens.set(grant.tokenHash, grant);
        }
      } finally {
        await file.close();
      }
      return store;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Viewing grants are closed"));
    if (this.pending >= 32)
      return Promise.reject(
        new ProtocolError("retry_later", "Viewing grant queue is full"),
      );
    this.pending++;
    const enqueue = () => {
      const result = this.queue.then(operation).finally(() => {
        this.pending--;
      });
      this.queue = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    return this.barrier ? this.barrier.shared(enqueue) : enqueue();
  }
  private async commit(next: Map<string, Grant>) {
    const saved = { version: 1, grants: [...next.values()] };
    if (Buffer.byteLength(canonicalJson(saved)) + 1 > 4 * 1024 * 1024)
      throw new ProtocolError(
        "retry_later",
        "Viewing grant storage limit reached",
      );
    await atomicJson(this.path, saved);
    this.grants = next;
    this.tokens = new Map(
      [...next.values()].map((grant) => [grant.tokenHash, grant]),
    );
  }
  issue(input: {
    streamId: string;
    revision: string;
    label: string;
    expiresAt: number;
  }) {
    const frozen = { ...input };
    return this.serial(async () => {
      const now = Date.now();
      if (
        !Number.isSafeInteger(frozen.expiresAt) ||
        frozen.expiresAt <= now ||
        frozen.expiresAt - now > 366 * 86400000
      )
        throw new ProtocolError(
          "invalid_request",
          "Viewing grant expiry must be within the next 366 days",
        );
      const token = randomBytes(32).toString("hex");
      const grant = grantSchema.parse({
        ...frozen,
        id: randomUUID(),
        createdAt: now,
        tokenHash: hash(token),
      });
      const next = new Map(
        [...this.grants].filter(([, item]) => item.expiresAt > now),
      );
      if (
        next.size >= 10000 ||
        [...next.values()].filter((item) => item.streamId === grant.streamId)
          .length >= 128
      )
        throw new ProtocolError("retry_later", "Viewing grant limit reached");
      next.set(grant.id, grant);
      await this.commit(next);
      return { ...publicGrant(grant), token };
    });
  }
  authorize(
    token: string,
    streamId: string,
    revision: string,
  ): ViewingGrant | undefined {
    if (this.closed || !/^[a-f0-9]{64}$/.test(token)) return;
    const grant = this.tokens.get(hash(token));
    if (
      !grant ||
      grant.streamId !== streamId ||
      grant.revision !== revision ||
      grant.expiresAt <= Date.now()
    )
      return;
    return publicGrant(grant);
  }
  /** An authorization lifetime for an active read, socket or pending ticket.
   * Consumers must abort delivery on signal and close after finishing work. */
  acquire(
    token: string,
    streamId: string,
    revision: string,
    parent?: AbortSignal,
  ) {
    parent?.throwIfAborted();
    const grant = this.authorize(token, streamId, revision);
    if (!grant)
      throw new ProtocolError(
        "forbidden",
        "Viewing credential is invalid or expired",
      );
    if (this.activeCount >= 4096)
      throw new ProtocolError("retry_later", "Too many active viewing grants");
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (reason: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
      const readers = this.active.get(grant.id);
      readers?.delete(revoke);
      if (!readers?.size) this.active.delete(grant.id);
      this.activeCount--;
      stop.abort(reason);
    };
    const revoke = () =>
      finish(new ProtocolError("forbidden", "Viewing credential was revoked"));
    const cancel = () => finish(parent!.reason);
    const expire = () => {
      const remaining = grant.expiresAt - Date.now();
      if (remaining <= 0)
        finish(new ProtocolError("forbidden", "Viewing credential expired"));
      else {
        timer = setTimeout(expire, Math.min(remaining, 2147483647));
        timer.unref();
      }
    };
    const readers = this.active.get(grant.id) ?? new Set<() => void>();
    readers.add(revoke);
    this.active.set(grant.id, readers);
    this.activeCount++;
    parent?.addEventListener("abort", cancel, { once: true });
    expire();
    return {
      grant,
      signal: stop.signal,
      close: () => finish(new Error("Viewing operation finished")),
    };
  }
  list(streamId: string): ViewingGrant[] {
    idSchema.parse(streamId);
    if (this.closed) throw new Error("Viewing grants are closed");
    return [...this.grants.values()]
      .filter(
        (grant) => grant.streamId === streamId && grant.expiresAt > Date.now(),
      )
      .map(publicGrant);
  }
  revoke(streamId: string, id: string): Promise<boolean> {
    idSchema.parse(streamId);
    idSchema.parse(id);
    return this.serial(async () => {
      const grant = this.grants.get(id);
      if (!grant || grant.streamId !== streamId) return false;
      const next = new Map(this.grants);
      next.delete(id);
      await this.commit(next);
      for (const invalidate of [...(this.active.get(id) ?? [])]) invalidate();
      for (const listener of this.listeners) {
        try {
          listener(id);
        } catch {
          /* Authorization is already revoked. */
        }
      }
      return true;
    });
  }
  onRevoke(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      for (const readers of [...this.active.values()])
        for (const invalidate of [...readers]) invalidate();
      this.closePromise = this.queue.then(async () => {
        this.listeners.clear();
        await this.lock.release();
      });
    }
    return this.closePromise;
  }
}
