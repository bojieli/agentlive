import { open, readdir, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProtocolError } from "@agentlive/protocol";
import type { FreeSpaceFloor } from "./free-space.js";

/** Owner of recordings created with the operator credential; never account-limited. */
export const LOCAL_OWNER = "local";

export const quotaLimitsSchema = z
  .strictObject({
    maxRecordingsPerAccount: z.number().int().min(1).max(1_000_000).optional(),
    maxActiveRecordingsPerAccount: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional(),
    maxStoredBytesPerAccount: z
      .number()
      .int()
      .min(4096)
      .max(2 ** 50)
      .optional(),
  })
  .refine(
    (value) =>
      value.maxActiveRecordingsPerAccount === undefined ||
      value.maxRecordingsPerAccount === undefined ||
      value.maxActiveRecordingsPerAccount <= value.maxRecordingsPerAccount,
    "maxActiveRecordingsPerAccount cannot exceed maxRecordingsPerAccount",
  );
export type QuotaLimits = z.infer<typeof quotaLimitsSchema>;

/** Server-wide storage limits; they apply to every writer, including the local owner. */
export const storageLimitsSchema = z.strictObject({
  maxStoredBytes: z
    .number()
    .int()
    .min(4096)
    .max(2 ** 50)
    .optional(),
  minFreeBytes: z
    .number()
    .int()
    .min(0)
    .max(2 ** 50)
    .optional(),
});
export type StorageLimits = z.infer<typeof storageLimitsSchema>;

export interface AccountUsage {
  recordings: number;
  activeRecordings: number;
  storedBytes: number;
}
/** One-shot pending quota admission; commit or release exactly once (later calls are ignored). */
export interface Reservation {
  commit(actualBytes: number): void;
  release(): void;
}
/** Per-recording usage hooks used by RecordingSession for durable writes. */
export interface RecordingUsage {
  /** Admit a durable write of up to `bytes` before it starts; throws quota_exceeded. */
  reserveBytes(bytes: number): Reservation;
  /** Count bytes that are always accepted (lifecycle records) or were deleted. */
  adjustBytes(delta: number): void;
  /** Admit a reopen before its record is written; throws quota_exceeded. */
  reserveActive(): Reservation;
  /** Record a committed end. */
  ended(): void;
}
interface RecordingEntry {
  ownerId: string;
  storedBytes: number;
  open: boolean;
}
interface AccountEntry extends AccountUsage {
  reservedBytes: number;
  reservedRecordings: number;
  reservedActive: number;
}
const idle: Reservation = { commit() {}, release() {} };

/**
 * In-memory usage derived from durable state: rebuilt by a startup scan,
 * reconciled whenever a recording is loaded, and updated on every durable write.
 * Every recording counts toward the server-wide totals; recordings of hosted
 * accounts also count toward their account. Admission reserves before writing and
 * checks account and server-wide limits together, so concurrent writers cannot
 * jointly overshoot either.
 */
export class AccountQuotas {
  private readonly accounts = new Map<string, AccountEntry>();
  private readonly recordings = new Map<string, RecordingEntry>();
  private readonly total = {
    recordings: 0,
    activeRecordings: 0,
    storedBytes: 0,
    reservedBytes: 0,
  };
  private readonly rejected = new Map<string, number>();
  readonly limits: Readonly<QuotaLimits>;
  readonly storageLimits: Readonly<{ maxStoredBytes?: number | undefined }>;
  /** Server-wide free-space floor, when configured. */
  readonly freeSpace: FreeSpaceFloor | undefined;
  constructor(
    limits: QuotaLimits = {},
    storage: { maxStoredBytes?: number; freeSpace?: FreeSpaceFloor } = {},
  ) {
    const parsed = quotaLimitsSchema.safeParse(limits);
    if (!parsed.success) throw new RangeError("Invalid quota configuration");
    this.limits = Object.freeze({ ...parsed.data });
    const global = storageLimitsSchema.safeParse(
      storage.maxStoredBytes === undefined
        ? {}
        : { maxStoredBytes: storage.maxStoredBytes },
    );
    if (!global.success)
      throw new RangeError("Invalid server storage limit configuration");
    this.storageLimits = Object.freeze({ ...global.data });
    this.freeSpace = storage.freeSpace;
  }
  /** Whether per-account limits and usage apply to this owner. */
  static tracks(ownerId: string) {
    return ownerId !== LOCAL_OWNER;
  }
  private account(ownerId: string): AccountEntry {
    let entry = this.accounts.get(ownerId);
    if (!entry) {
      entry = {
        recordings: 0,
        activeRecordings: 0,
        storedBytes: 0,
        reservedBytes: 0,
        reservedRecordings: 0,
        reservedActive: 0,
      };
      this.accounts.set(ownerId, entry);
    }
    return entry;
  }
  private accountFor(ownerId: string): AccountEntry | undefined {
    return AccountQuotas.tracks(ownerId) ? this.account(ownerId) : undefined;
  }
  /** Limits as exposed to clients; `null` means unlimited. */
  get publicLimits() {
    return {
      maxRecordingsPerAccount: this.limits.maxRecordingsPerAccount ?? null,
      maxActiveRecordingsPerAccount:
        this.limits.maxActiveRecordingsPerAccount ?? null,
      maxStoredBytesPerAccount: this.limits.maxStoredBytesPerAccount ?? null,
    };
  }
  usage(ownerId: string): AccountUsage {
    const entry = this.accounts.get(ownerId);
    return {
      recordings: entry?.recordings ?? 0,
      activeRecordings: entry?.activeRecordings ?? 0,
      storedBytes: entry?.storedBytes ?? 0,
    };
  }
  /** Server-wide aggregates over every owner (content-free; used by metrics). */
  get totals() {
    return {
      ...this.total,
      accounts: this.accounts.size,
      rejections: [...this.rejected].map(([key, count]) => {
        const [quota, scope] = key.split(" ") as [string, string];
        return { quota, scope, count };
      }),
    };
  }
  /** Authoritative durable size and lifecycle of a live recording (scan or load). */
  track(id: string, ownerId: string, storedBytes: number, open: boolean) {
    this.forget(id);
    this.total.recordings++;
    this.total.storedBytes += storedBytes;
    if (open) this.total.activeRecordings++;
    const account = this.accountFor(ownerId);
    if (account) {
      account.recordings++;
      account.storedBytes += storedBytes;
      if (open) account.activeRecordings++;
    }
    this.recordings.set(id, { ownerId, storedBytes, open });
  }
  /** A removal tombstone was committed; the recording no longer counts. */
  forget(id: string) {
    const entry = this.recordings.get(id);
    if (!entry) return;
    this.recordings.delete(id);
    this.total.recordings--;
    this.total.storedBytes -= entry.storedBytes;
    if (entry.open) this.total.activeRecordings--;
    const account = this.accountFor(entry.ownerId);
    if (account) {
      account.recordings--;
      account.storedBytes -= entry.storedBytes;
      if (entry.open) account.activeRecordings--;
    }
  }
  private reject(
    quota: string,
    scope: "account" | "global",
    message: string,
    details: Record<string, unknown>,
  ): never {
    const key = `${quota} ${scope}`;
    this.rejected.set(key, (this.rejected.get(key) ?? 0) + 1);
    throw new ProtocolError("quota_exceeded", message, {
      quota,
      scope,
      ...details,
    });
  }
  private checkBytes(
    ownerId: string,
    account: AccountEntry | undefined,
    bytes: number,
  ) {
    if (bytes <= 0) return;
    const limit = this.limits.maxStoredBytesPerAccount;
    if (
      account &&
      limit !== undefined &&
      account.storedBytes + account.reservedBytes + bytes > limit
    )
      this.reject(
        "maxStoredBytesPerAccount",
        "account",
        `Account storage quota exceeded: ${account.storedBytes} of ${limit} bytes used; this write needs ${bytes} more bytes`,
        {
          limit,
          used: account.storedBytes,
          requested: bytes,
          accountId: ownerId,
        },
      );
    const global = this.storageLimits.maxStoredBytes;
    // Server-wide usage is not disclosed to accounts; only the limit and request.
    if (
      global !== undefined &&
      this.total.storedBytes + this.total.reservedBytes + bytes > global
    )
      this.reject(
        "maxStoredBytes",
        "global",
        `Server storage quota exceeded: the server stores at most ${global} bytes; this write needs ${bytes} more bytes`,
        { limit: global, requested: bytes },
      );
    try {
      this.freeSpace?.admit(bytes, this.total.reservedBytes);
    } catch (error) {
      if (error instanceof ProtocolError) {
        const key = "minFreeBytes global";
        this.rejected.set(key, (this.rejected.get(key) ?? 0) + 1);
      }
      throw error;
    }
  }
  private checkActive(ownerId: string, account: AccountEntry | undefined) {
    const limit = this.limits.maxActiveRecordingsPerAccount;
    if (
      account &&
      limit !== undefined &&
      account.activeRecordings + account.reservedActive + 1 > limit
    )
      this.reject(
        "maxActiveRecordingsPerAccount",
        "account",
        `Account active recording quota exceeded: ${account.activeRecordings} of ${limit} recordings are open; finish one first`,
        { limit, used: account.activeRecordings, accountId: ownerId },
      );
  }
  private checkRecordings(ownerId: string, account: AccountEntry | undefined) {
    const limit = this.limits.maxRecordingsPerAccount;
    if (
      account &&
      limit !== undefined &&
      account.recordings + account.reservedRecordings + 1 > limit
    )
      this.reject(
        "maxRecordingsPerAccount",
        "account",
        `Account recording quota exceeded: ${account.recordings} of ${limit} recordings stored; remove one first`,
        { limit, used: account.recordings, accountId: ownerId },
      );
  }
  private reserveTotal(account: AccountEntry | undefined, bytes: number) {
    this.total.reservedBytes += bytes;
    if (account) account.reservedBytes += bytes;
  }
  /**
   * Largest durable growth this owner could still be admitted for, or undefined
   * when nothing bounds it. Advisory: it bounds how many bytes are worth
   * staging, while admission stays authoritative and may still refuse.
   */
  admissibleBytes(ownerId: string): number | undefined {
    const account = this.accountFor(ownerId);
    const limits: number[] = [];
    const perAccount = this.limits.maxStoredBytesPerAccount;
    if (account && perAccount !== undefined)
      limits.push(perAccount - account.storedBytes - account.reservedBytes);
    const global = this.storageLimits.maxStoredBytes;
    if (global !== undefined)
      limits.push(global - this.total.storedBytes - this.total.reservedBytes);
    return limits.length ? Math.max(0, Math.min(...limits)) : undefined;
  }
  /** Advisory check before accepting a large upload body; the store rechecks authoritatively. */
  precheckRecording(ownerId: string) {
    const account = this.accountFor(ownerId);
    this.checkRecordings(ownerId, account);
    this.checkBytes(ownerId, account, 1);
  }
  /**
   * Admit a new recording (creation or import) of about `bytes` stored bytes.
   * `adjust` re-admits the measured size before installation; `commit` binds it to its ID.
   */
  reserveRecording(
    ownerId: string,
    options: { bytes: number; open: boolean },
  ): {
    adjust(bytes: number): void;
    commit(id: string, actualBytes: number): void;
    release(): void;
  } {
    const account = this.accountFor(ownerId);
    this.checkRecordings(ownerId, account);
    if (options.open) this.checkActive(ownerId, account);
    this.checkBytes(ownerId, account, options.bytes);
    let reserved = options.bytes;
    let settled = false;
    if (account) {
      account.reservedRecordings++;
      if (options.open) account.reservedActive++;
    }
    this.reserveTotal(account, reserved);
    const release = () => {
      if (settled) return;
      settled = true;
      if (account) {
        account.reservedRecordings--;
        if (options.open) account.reservedActive--;
      }
      this.reserveTotal(account, -reserved);
    };
    return {
      adjust: (bytes) => {
        if (settled) return;
        this.reserveTotal(account, -reserved);
        try {
          this.checkBytes(ownerId, account, bytes);
        } catch (error) {
          this.reserveTotal(account, reserved);
          throw error;
        }
        reserved = bytes;
        this.reserveTotal(account, reserved);
      },
      commit: (id, actualBytes) => {
        if (settled) return;
        release();
        this.track(id, ownerId, actualBytes, options.open);
        this.freeSpace?.grew(actualBytes);
      },
      release,
    };
  }
  /** Hooks for one recording's durable writes (every owner counts server-wide). */
  forRecording(id: string, _ownerId: string): RecordingUsage {
    const current = () => {
      const entry = this.recordings.get(id);
      return entry && { entry, account: this.accountFor(entry.ownerId) };
    };
    return {
      reserveBytes: (bytes) => {
        const target = current();
        if (!target || bytes <= 0) return idle;
        this.checkBytes(target.entry.ownerId, target.account, bytes);
        const { account } = target;
        this.reserveTotal(account, bytes);
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          this.reserveTotal(account, -bytes);
        };
        return {
          commit: (actualBytes) => {
            if (settled) return;
            release();
            this.adjust(id, actualBytes);
          },
          release,
        };
      },
      adjustBytes: (delta) => this.adjust(id, delta),
      reserveActive: () => {
        const target = current();
        if (!target || target.entry.open) return idle;
        this.checkActive(target.entry.ownerId, target.account);
        const { account } = target;
        if (account) account.reservedActive++;
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          if (account) account.reservedActive--;
        };
        return {
          commit: () => {
            if (settled) return;
            release();
            const entry = this.recordings.get(id);
            if (entry && !entry.open) {
              entry.open = true;
              this.total.activeRecordings++;
              const owner = this.accountFor(entry.ownerId);
              if (owner) owner.activeRecordings++;
            }
          },
          release,
        };
      },
      ended: () => {
        const entry = this.recordings.get(id);
        if (entry?.open) {
          entry.open = false;
          this.total.activeRecordings--;
          const owner = this.accountFor(entry.ownerId);
          if (owner) owner.activeRecordings--;
        }
      },
    };
  }
  private adjust(id: string, delta: number) {
    const entry = this.recordings.get(id);
    if (!entry || !delta) return;
    entry.storedBytes += delta;
    this.total.storedBytes += delta;
    const account = this.accountFor(entry.ownerId);
    if (account) account.storedBytes += delta;
    this.freeSpace?.grew(delta);
  }
}

/**
 * Startup estimate of one recording's stored bytes (event log plus installed
 * attachments) and lifecycle, without replaying its log. A recording is ended exactly
 * when its last complete log record is `recording.ended` (nothing can follow an end
 * except a reopen); anything uncertain is counted as open. Loading the recording later
 * reconciles both values with the recovered state.
 */
export async function scanRecordingUsage(
  directory: string,
): Promise<{ storedBytes: number; open: boolean }> {
  const logPath = join(directory, "events.jsonl");
  let storedBytes = (await stat(logPath)).size;
  try {
    for (const entry of await readdir(join(directory, "attachments"), {
      withFileTypes: true,
    }))
      if (entry.name !== ".uploads" && entry.isFile())
        storedBytes += (await lstat(join(directory, "attachments", entry.name)))
          .size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let isOpen = true;
  const file = await open(logPath, "r");
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(
        buffer,
        read,
        length - read,
        size - length + read,
      );
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const window = buffer.subarray(0, read);
    const end = window.lastIndexOf(10);
    if (end !== -1) {
      const start = end > 0 ? window.lastIndexOf(10, end - 1) : -1;
      if (start !== -1 || size === read) {
        try {
          const record = JSON.parse(
            window.subarray(start + 1, end).toString("utf8"),
          );
          isOpen = record?.value?.content?.kind !== "recording.ended";
        } catch {
          isOpen = true;
        }
      }
    }
  } finally {
    await file.close();
  }
  return { storedBytes, open: isOpen };
}
