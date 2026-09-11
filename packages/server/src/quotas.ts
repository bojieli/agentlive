import { open, readdir, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProtocolError } from "@agentlive/protocol";

/** Owner of recordings created with the operator credential; never quota-limited. */
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
 * In-memory per-account usage derived from durable state: rebuilt by a startup scan,
 * reconciled whenever a recording is loaded, and updated on every durable write.
 * Admission reserves before writing, so concurrent writers cannot jointly overshoot.
 */
export class AccountQuotas {
  private readonly accounts = new Map<string, AccountEntry>();
  private readonly recordings = new Map<string, RecordingEntry>();
  readonly limits: Readonly<QuotaLimits>;
  constructor(limits: QuotaLimits = {}) {
    const parsed = quotaLimitsSchema.safeParse(limits);
    if (!parsed.success) throw new RangeError("Invalid quota configuration");
    this.limits = Object.freeze({ ...parsed.data });
  }
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
  /** Authoritative durable size and lifecycle of a live recording (scan or load). */
  track(id: string, ownerId: string, storedBytes: number, open: boolean) {
    if (!AccountQuotas.tracks(ownerId)) return;
    this.forget(id);
    const account = this.account(ownerId);
    account.recordings++;
    account.storedBytes += storedBytes;
    if (open) account.activeRecordings++;
    this.recordings.set(id, { ownerId, storedBytes, open });
  }
  /** A removal tombstone was committed; the recording no longer counts. */
  forget(id: string) {
    const entry = this.recordings.get(id);
    if (!entry) return;
    this.recordings.delete(id);
    const account = this.account(entry.ownerId);
    account.recordings--;
    account.storedBytes -= entry.storedBytes;
    if (entry.open) account.activeRecordings--;
  }
  private checkBytes(ownerId: string, account: AccountEntry, bytes: number) {
    const limit = this.limits.maxStoredBytesPerAccount;
    if (
      limit !== undefined &&
      bytes > 0 &&
      account.storedBytes + account.reservedBytes + bytes > limit
    )
      throw new ProtocolError(
        "quota_exceeded",
        `Account storage quota exceeded: ${account.storedBytes} of ${limit} bytes used; this write needs ${bytes} more bytes`,
        {
          quota: "maxStoredBytesPerAccount",
          limit,
          used: account.storedBytes,
          requested: bytes,
          accountId: ownerId,
        },
      );
  }
  private checkActive(ownerId: string, account: AccountEntry) {
    const limit = this.limits.maxActiveRecordingsPerAccount;
    if (
      limit !== undefined &&
      account.activeRecordings + account.reservedActive + 1 > limit
    )
      throw new ProtocolError(
        "quota_exceeded",
        `Account active recording quota exceeded: ${account.activeRecordings} of ${limit} recordings are open; finish one first`,
        {
          quota: "maxActiveRecordingsPerAccount",
          limit,
          used: account.activeRecordings,
          accountId: ownerId,
        },
      );
  }
  private checkRecordings(ownerId: string, account: AccountEntry) {
    const limit = this.limits.maxRecordingsPerAccount;
    if (
      limit !== undefined &&
      account.recordings + account.reservedRecordings + 1 > limit
    )
      throw new ProtocolError(
        "quota_exceeded",
        `Account recording quota exceeded: ${account.recordings} of ${limit} recordings stored; remove one first`,
        {
          quota: "maxRecordingsPerAccount",
          limit,
          used: account.recordings,
          accountId: ownerId,
        },
      );
  }
  /** Advisory check before accepting a large upload body; the store rechecks authoritatively. */
  precheckRecording(ownerId: string) {
    if (!AccountQuotas.tracks(ownerId)) return;
    const account = this.account(ownerId);
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
    if (!AccountQuotas.tracks(ownerId))
      return { adjust() {}, commit() {}, release() {} };
    const account = this.account(ownerId);
    this.checkRecordings(ownerId, account);
    if (options.open) this.checkActive(ownerId, account);
    this.checkBytes(ownerId, account, options.bytes);
    let reserved = options.bytes;
    let settled = false;
    account.reservedRecordings++;
    if (options.open) account.reservedActive++;
    account.reservedBytes += reserved;
    const release = () => {
      if (settled) return;
      settled = true;
      account.reservedRecordings--;
      if (options.open) account.reservedActive--;
      account.reservedBytes -= reserved;
    };
    return {
      adjust: (bytes) => {
        if (settled) return;
        account.reservedBytes -= reserved;
        try {
          this.checkBytes(ownerId, account, bytes);
        } catch (error) {
          account.reservedBytes += reserved;
          throw error;
        }
        reserved = bytes;
        account.reservedBytes += reserved;
      },
      commit: (id, actualBytes) => {
        if (settled) return;
        release();
        this.track(id, ownerId, actualBytes, options.open);
      },
      release,
    };
  }
  /** Hooks for one recording's durable writes, or undefined for untracked owners. */
  forRecording(id: string, ownerId: string): RecordingUsage | undefined {
    if (!AccountQuotas.tracks(ownerId)) return undefined;
    const current = () => {
      const entry = this.recordings.get(id);
      return entry && { entry, account: this.account(entry.ownerId) };
    };
    return {
      reserveBytes: (bytes) => {
        const target = current();
        if (!target || bytes <= 0) return idle;
        this.checkBytes(target.entry.ownerId, target.account, bytes);
        const { account } = target;
        account.reservedBytes += bytes;
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          account.reservedBytes -= bytes;
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
        account.reservedActive++;
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          account.reservedActive--;
        };
        return {
          commit: () => {
            if (settled) return;
            release();
            const entry = this.recordings.get(id);
            if (entry && !entry.open) {
              entry.open = true;
              this.account(entry.ownerId).activeRecordings++;
            }
          },
          release,
        };
      },
      ended: () => {
        const entry = this.recordings.get(id);
        if (entry?.open) {
          entry.open = false;
          this.account(entry.ownerId).activeRecordings--;
        }
      },
    };
  }
  private adjust(id: string, delta: number) {
    const entry = this.recordings.get(id);
    if (!entry || !delta) return;
    entry.storedBytes += delta;
    this.account(entry.ownerId).storedBytes += delta;
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
