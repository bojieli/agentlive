import { constants } from "node:fs";
import type { WriteBarrier } from "./write-barrier.js";
import { mkdir, lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson, FileLock } from "@agentlive/storage";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";

const identitySchema = z.strictObject({
  issuer: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  subject: z.string().min(1).max(255),
  displayName: z.string().min(1).max(200),
});
const recordSchema = identitySchema.extend({
  format: z.literal(1),
  id: z.uuid(),
  version: z.number().int().positive().safe(),
  disabled: z.boolean(),
  authVersion: z.number().int().nonnegative().safe().default(0),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
});
type Record = z.infer<typeof recordSchema>;
export type Account = Omit<Record, "format" | "issuer" | "subject">;
const publicAccount = ({
  format: _,
  issuer: __,
  subject: ___,
  ...account
}: Record): Account => account;
const identityKey = (identity: { issuer: string; subject: string }) =>
  canonicalJson([identity.issuer, identity.subject]);

/** Identity verification belongs to the OIDC adapter; this store never accepts passwords or provider tokens. */
export class Accounts {
  private records = new Map<string, Record>();
  private identities = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private closed: Promise<void> | undefined;
  private readonly listeners = new Set<(id: string) => void>();
  private constructor(
    private directory: string,
    private lock: FileLock,
  ) {}

  /** Online backup admission gate for ledger mutations. */
  private barrier: WriteBarrier | undefined;
  static async open(directory: string, barrier?: WriteBarrier) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Account directory must be private and cannot be a symlink",
      );
    const lock = await FileLock.acquire(join(directory, ".accounts.lock"));
    const store = new Accounts(directory, lock);
    store.barrier = barrier;
    try {
      let entries = 0;
      for await (const entry of await opendir(directory)) {
        if (++entries > 20001)
          throw new Error("Account directory entry limit exceeded");
        if (
          entry.name === ".accounts.lock" ||
          /^\.[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name)
        )
          continue;
        if (!/^[a-f0-9-]{36}\.json$/.test(entry.name) || !entry.isFile())
          throw new Error("Unexpected account directory entry");
        if (store.records.size >= 10000)
          throw new Error("Account limit exceeded");
        const file = await open(
          join(directory, entry.name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0)
            throw new Error("Invalid account file");
          const bytes = Buffer.alloc(16385);
          let length = 0;
          while (length < bytes.length) {
            const read = await file.read(
              bytes,
              length,
              bytes.length - length,
              null,
            );
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length > 16384) throw new Error("Account file exceeds limit");
          let record: Record;
          try {
            record = recordSchema.parse(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes.subarray(0, length),
                ),
              ),
            );
          } catch {
            throw new Error("Invalid account record");
          }
          if (
            entry.name !== record.id + ".json" ||
            record.updatedAt < record.createdAt ||
            store.identities.has(identityKey(record))
          )
            throw new Error("Conflicting account identity");
          store.records.set(record.id, record);
          store.identities.set(identityKey(record), record.id);
        } finally {
          await file.close();
        }
      }
      return store;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  get(id: string): Account | undefined {
    const record = this.records.get(id);
    return record && publicAccount(record);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Account store is closing"));
    if (this.pending >= 32)
      return Promise.reject(
        new ProtocolError("retry_later", "Account mutation queue is full"),
      );
    this.pending++;
    const enqueue = () => {
      const run = this.queue.then(action).finally(() => {
        this.pending--;
      });
      this.queue = run.catch(() => {});
      return run;
    };
    return this.barrier ? this.barrier.shared(enqueue) : enqueue();
  }
  private async save(record: Record) {
    recordSchema.parse(record);
    if (Buffer.byteLength(canonicalJson(record)) > 16384)
      throw new Error("Account record exceeds limit");
    await atomicJson(join(this.directory, record.id + ".json"), record);
    this.records.set(record.id, record);
    this.identities.set(identityKey(record), record.id);
  }
  /** Call only with issuer/sub claims from a successfully verified OIDC login. Email is never an identity key. */
  resolveVerifiedIdentity(
    input: z.infer<typeof identitySchema>,
  ): Promise<Account> {
    const identity = identitySchema.parse(input);
    return this.serial(async () => {
      const id = this.identities.get(identityKey(identity));
      const previous = id ? this.records.get(id)! : undefined;
      if (previous?.disabled)
        throw new ProtocolError("forbidden", "Account is disabled");
      if (previous?.displayName === identity.displayName)
        return publicAccount(previous);
      if (!previous && this.records.size >= 10000)
        throw new ProtocolError("retry_later", "Account limit reached");
      const now = Math.max(Date.now(), previous?.updatedAt ?? 0);
      const record: Record = previous
        ? {
            ...previous,
            displayName: identity.displayName,
            version: previous.version + 1,
            updatedAt: now,
          }
        : {
            ...identity,
            format: 1,
            id: randomUUID(),
            version: 1,
            disabled: false,
            authVersion: 0,
            createdAt: now,
            updatedAt: now,
          };
      await this.save(record);
      return publicAccount(record);
    });
  }
  /** Administration must authenticate the service operator before calling this method. */
  setDisabled(
    id: string,
    expectedVersion: number,
    disabled: boolean,
  ): Promise<Account> {
    return this.serial(async () => {
      const previous = this.records.get(id);
      if (!previous)
        throw new ProtocolError("stream_gone", "Account does not exist");
      if (previous.version !== expectedVersion)
        throw new ProtocolError(
          "precondition_failed",
          "Account version changed",
        );
      if (previous.disabled === disabled) return publicAccount(previous);
      const next = {
        ...previous,
        version: previous.version + 1,
        disabled,
        authVersion: previous.authVersion + 1,
        updatedAt: Math.max(Date.now(), previous.updatedAt),
      };
      await this.save(next);
      for (const listener of [...this.listeners]) {
        try {
          listener(id);
        } catch {
          /* The status change is already durable. */
        }
      }
      return publicAccount(next);
    });
  }
  /** Observe committed disable/enable changes, e.g. to recheck active transfers. */
  onStatusChange(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close(): Promise<void> {
    this.closing = true;
    return (this.closed ??= this.queue.then(() => this.lock.release()));
  }
}
