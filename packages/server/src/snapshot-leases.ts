import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "@agentlive/storage";
import {
  ProtocolError,
  idSchema,
  snapshotDescriptorSchema,
  snapshotLeaseSchema,
  snapshotLeaseTokenSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import type { SnapshotBinding } from "@agentlive/playback";

const tokenSchema = snapshotLeaseTokenSchema;
const leaseSchema = snapshotLeaseSchema;
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  streamId: idSchema,
  revision: idSchema,
  leases: z.array(leaseSchema).max(128),
  observedAt: z.number().int().nonnegative().safe(),
});
export type SnapshotLease = z.infer<typeof leaseSchema>;
/** Durable roots, owned by RecordingSnapshots. Caller holds its publication queue and
 * recording lock across every operation, including retained() through any sweep.
 * Tokens identify retention only; HTTP authorization must be checked independently.
 */
export class SnapshotLeases {
  private readonly binding: SnapshotBinding;
  constructor(
    private readonly directory: string,
    binding: SnapshotBinding,
    private readonly now: () => number = Date.now,
    private readonly capacity = 128,
    private readonly durationMs = 15 * 60 * 1000,
  ) {
    this.binding = {
      streamId: idSchema.parse(binding.streamId),
      revision: idSchema.parse(binding.revision),
    };
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > 128 ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1 ||
      durationMs > 86400000
    )
      throw new RangeError("Invalid snapshot lease limits");
  }
  private time(observedAt = 0) {
    const now = Math.max(this.now(), observedAt);
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(now + this.durationMs)
    )
      throw new RangeError("Invalid snapshot lease clock");
    return now;
  }
  private async load(): Promise<z.infer<typeof ledgerSchema>> {
    let file;
    try {
      file = await open(
        join(this.directory, "leases.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, ...this.binding, leases: [], observedAt: 0 };
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 131072)
        throw new Error("Invalid lease ledger size");
      const bytes = Buffer.alloc(131073);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== stat.size || length > 131072)
        throw new Error("Invalid lease ledger length");
      const ledger = ledgerSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, length),
          ),
        ),
      );
      if (
        ledger.streamId !== this.binding.streamId ||
        ledger.revision !== this.binding.revision
      )
        throw new ProtocolError(
          "revision_changed",
          "Snapshot lease binding differs from recording",
        );
      if (
        new Set(ledger.leases.map((lease) => lease.token)).size !==
        ledger.leases.length
      )
        throw new Error("Duplicate snapshot lease");
      return ledger;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        "corrupt_storage",
        "Invalid snapshot lease ledger",
      );
    } finally {
      await file.close();
    }
  }
  private save(leases: SnapshotLease[], observedAt: number) {
    return atomicJson(join(this.directory, "leases.json"), {
      version: 1,
      ...this.binding,
      leases,
      observedAt,
    });
  }
  async acquire(
    snapshot: SnapshotDescriptor,
    signal?: AbortSignal,
  ): Promise<SnapshotLease> {
    const copied = snapshotDescriptorSchema.parse(snapshot);
    if (copied.format !== "agentlive.paged-state" || !copied.activity)
      throw new ProtocolError(
        "invalid_request",
        "Snapshot lease requires paired roots",
      );
    signal?.throwIfAborted();
    const all = await this.load(),
      now = this.time(all.observedAt);
    const leases = all.leases.filter((lease) => lease.expiresAt > now);
    if (leases.length >= this.capacity)
      throw new ProtocolError("retry_later", "Snapshot leases are at capacity");
    const lease = leaseSchema.parse({
      token: randomBytes(32).toString("hex"),
      expiresAt: now + this.durationMs,
      snapshot: copied,
    });
    signal?.throwIfAborted();
    await this.save([...leases, lease], now);
    // Once publication starts, cancellation cannot retract the durable retention promise.
    return lease;
  }
  async renew(token: string, signal?: AbortSignal): Promise<SnapshotLease> {
    tokenSchema.parse(token);
    signal?.throwIfAborted();
    const all = await this.load(),
      now = this.time(all.observedAt);
    const leases = all.leases.filter((lease) => lease.expiresAt > now);
    const lease = leases.find((lease) => lease.token === token);
    if (!lease)
      throw new ProtocolError(
        "stale_lease",
        "Snapshot lease expired or was released",
      );
    lease.expiresAt = Math.max(lease.expiresAt, now + this.durationMs);
    signal?.throwIfAborted();
    await this.save(leases, now);
    return lease;
  }
  /** Caller keeps the publication queue held until the accepted read finishes. */
  async validate(token: string, signal?: AbortSignal): Promise<SnapshotLease> {
    tokenSchema.parse(token);
    signal?.throwIfAborted();
    const all = await this.load(),
      now = this.time(all.observedAt);
    signal?.throwIfAborted();
    const lease = all.leases.find(
      (lease) => lease.token === token && lease.expiresAt > now,
    );
    if (!lease)
      throw new ProtocolError(
        "stale_lease",
        "Snapshot lease expired or was released",
      );
    return lease;
  }
  async release(token: string, signal?: AbortSignal): Promise<void> {
    tokenSchema.parse(token);
    signal?.throwIfAborted();
    const all = await this.load(),
      now = this.time(all.observedAt);
    const next = all.leases.filter(
      (lease) => lease.token !== token && lease.expiresAt > now,
    );
    signal?.throwIfAborted();
    await this.save(next, now);
  }
  async retained(signal?: AbortSignal): Promise<SnapshotLease[]> {
    signal?.throwIfAborted();
    const all = await this.load(),
      now = this.time(all.observedAt);
    const retained = all.leases.filter((lease) => lease.expiresAt > now);
    signal?.throwIfAborted();
    // Persist pruning before a collector can act on the returned roots. A backward
    // clock adjustment must never resurrect a lease after its content was swept.
    await this.save(retained, now);
    return retained;
  }
}
