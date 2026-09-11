import { constants } from "node:fs";
import type { WriteBarrier } from "./write-barrier.js";
import { open } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { sealData, unsealData } from "iron-session";
import { z } from "zod";
import { atomicJson, FileLock } from "@agentlive/storage";
import { Accounts } from "./accounts.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
  managementId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  createdAt: z.number().int().nonnegative().safe().optional(),
  kind: z.enum(["browser", "device"]).default("browser"),
  hash: hex,
  accountId: z.uuid(),
  authVersion: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
const cookieSchema = z.strictObject({ id: hex, csrf: hex });
type Record = z.infer<typeof recordSchema>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const lifetimeSeconds = 8 * 60 * 60;

/** Durable session admission/revocation; iron-session supplies authenticated cookie sealing. */
export class AccountSessions {
  private records = new Map<string, Record>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private closed: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private constructor(
    private path: string,
    private accounts: Accounts,
    private password: string,
    private lock: FileLock,
  ) {}
  /** Online backup admission gate for ledger mutations. */
  private barrier: WriteBarrier | undefined;
  static async open(
    path: string,
    accounts: Accounts,
    password: string,
    barrier?: WriteBarrier,
  ) {
    if (password.length < 32)
      throw new Error(
        "Session cookie password must contain at least 32 characters",
      );
    const lock = await FileLock.acquire(path + ".lock");
    const store = new AccountSessions(path, accounts, password, lock);
    store.barrier = barrier;
    try {
      let file;
      try {
        file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
        throw error;
      }
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.size > 4 * 1024 * 1024 ||
          (info.mode & 0o077) !== 0
        )
          throw new Error("Invalid account session file");
        const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
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
        if (length > 4 * 1024 * 1024)
          throw new Error("Account session file exceeds limit");
        let saved;
        try {
          saved = z
            .strictObject({
              version: z.literal(1),
              sessions: z.array(recordSchema).max(10000),
            })
            .parse(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes.subarray(0, length),
                ),
              ),
            );
        } catch {
          throw new Error("Invalid account session records");
        }
        for (const record of saved.sessions) {
          if (store.records.has(record.hash))
            throw new Error("Duplicate account session");
          if (
            record.managementId &&
            [...store.records.values()].some(
              (other) => other.managementId === record.managementId,
            )
          )
            throw new Error("Duplicate session management ID");
          store.records.set(record.hash, record);
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
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Account sessions are closing"));
    if (this.pending >= 32)
      return Promise.reject(
        new Error("Account session mutation queue is full"),
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
  private async save(records: Map<string, Record>) {
    await atomicJson(this.path, {
      version: 1,
      sessions: [...records.values()],
    });
    this.records = records;
  }
  issue(accountId: string) {
    return this.issueRecord(accountId, "browser");
  }
  async issueDevice(accountId: string) {
    const issued = await this.issueRecord(accountId, "device");
    return { token: issued.cookie, expiresAt: issued.expiresAt };
  }
  private issueRecord(accountId: string, kind: "browser" | "device") {
    return this.serial(async () => {
      const account = this.accounts.get(accountId);
      if (!account || account.disabled)
        throw new Error("Account cannot sign in");
      const records = new Map(
        [...this.records].filter(([, record]) => record.expiresAt > Date.now()),
      );
      if (records.size >= 10000)
        throw new Error("Account session limit reached");
      const id = randomBytes(32).toString("hex"),
        csrf = randomBytes(32).toString("hex");
      const cookie =
        kind === "device"
          ? "ald1_" + id
          : await sealData(
              { id, csrf },
              { password: this.password, ttl: lifetimeSeconds },
            );
      const expiresAt = Date.now() + lifetimeSeconds * 1000;
      records.set(hash(id), {
        managementId: randomBytes(16).toString("hex"),
        createdAt: Date.now(),
        kind,
        hash: hash(id),
        accountId,
        authVersion: account.authVersion,
        expiresAt,
      });
      await this.save(records);
      return { cookie, csrf, expiresAt, maxAge: lifetimeSeconds };
    });
  }
  private async unseal(cookie: string) {
    if (cookie.length > 4096) return undefined;
    try {
      return cookieSchema.parse(
        await unsealData(cookie, {
          password: this.password,
          ttl: lifetimeSeconds,
        }),
      );
    } catch {
      return undefined;
    }
  }
  listDevices(accountId: string) {
    return this.serial(async () => {
      const account = this.accounts.get(accountId);
      if (!account || account.disabled) throw new Error("Account unavailable");
      const records = new Map(this.records);
      let migrated = false;
      const devices = [];
      for (const [key, saved] of records) {
        if (
          saved.kind !== "device" ||
          saved.accountId !== accountId ||
          saved.authVersion !== account.authVersion ||
          saved.expiresAt <= Date.now()
        )
          continue;
        let record = saved;
        if (!record.managementId) {
          record = { ...record, managementId: randomBytes(16).toString("hex") };
          records.set(key, record);
          migrated = true;
        }
        devices.push({
          id: record.managementId!,
          createdAt: record.createdAt ?? null,
          expiresAt: record.expiresAt,
        });
      }
      if (migrated) await this.save(records);
      return devices;
    });
  }
  revokeAccountDevice(accountId: string, managementId: string) {
    if (!/^[a-f0-9]{32}$/.test(managementId)) return Promise.resolve(false);
    return this.serial(async () => {
      const records = new Map(this.records);
      for (const [key, record] of records) {
        if (
          record.kind === "device" &&
          record.accountId === accountId &&
          record.managementId === managementId
        ) {
          records.delete(key);
          await this.save(records);
          this.notify();
          return true;
        }
      }
      return false;
    });
  }
  async authenticate(cookie: string) {
    if (this.closing) return undefined;
    const value = await this.unseal(cookie);
    if (!value || this.closing) return undefined;
    return this.principal(value.id, "browser", value.csrf);
  }
  authenticateDevice(token: string) {
    if (!/^ald1_[a-f0-9]{64}$/.test(token)) return undefined;
    return this.principal(token.slice(5), "device", "");
  }
  private principal(id: string, kind: "browser" | "device", csrf: string) {
    if (this.closing) return undefined;
    const record = this.records.get(hash(id));
    if (record?.kind !== kind) return undefined;
    if (!record || record.expiresAt <= Date.now()) return undefined;
    const account = this.accounts.get(record.accountId);
    if (
      !account ||
      account.disabled ||
      account.authVersion !== record.authVersion
    )
      return undefined;
    const isActive = () => {
      const current = this.accounts.get(record.accountId);
      return (
        !this.closing &&
        this.records.get(record.hash) === record &&
        record.expiresAt > Date.now() &&
        !!current &&
        !current.disabled &&
        current.authVersion === record.authVersion
      );
    };
    return { account, csrf, expiresAt: record.expiresAt, isActive };
  }
  async revoke(cookie: string) {
    const value = await this.unseal(cookie);
    if (!value) return false;
    return this.revokeId(value.id, "browser");
  }
  revokeDevice(token: string) {
    if (!/^ald1_[a-f0-9]{64}$/.test(token)) return Promise.resolve(false);
    return this.revokeId(token.slice(5), "device");
  }
  private revokeId(id: string, kind: "browser" | "device") {
    return this.serial(async () => {
      const records = new Map(this.records);
      if (records.get(hash(id))?.kind !== kind || !records.delete(hash(id)))
        return false;
      await this.save(records);
      this.notify();
      return true;
    });
  }
  /** Observe committed revocations, e.g. to recheck active transfers. */
  onRevoke(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* Revocation is already durable. */
      }
    }
  }
  static validCsrf(expected: string, received: string | undefined): boolean {
    return (
      !!received &&
      /^[a-f0-9]{64}$/.test(received) &&
      /^[a-f0-9]{64}$/.test(expected) &&
      timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(received, "hex"),
      )
    );
  }
  close(): Promise<void> {
    this.closing = true;
    return (this.closed ??= this.queue.then(() => this.lock.release()));
  }
}
