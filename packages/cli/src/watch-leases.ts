import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { atomicJson, type SubscriberCache } from "@agentlive/storage";
import {
  canonicalJson,
  ProtocolError,
  snapshotLeaseSchema,
  type SnapshotLease,
} from "@agentlive/protocol";
/** Owned by the subscriber-cache lock. Independent of the content queue so a lazy
 * read can persist renewal. Close drains accepted filesystem publication.
 */
export class TerminalLeaseCatalog {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly cache: Pick<
      SubscriberCache,
      "contentDirectory" | "binding"
    >,
  ) {}
  private run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Terminal lease catalog is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Terminal lease queue is full"),
      );
    this.pending++;
    const task = this.tail
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async read(signal: AbortSignal): Promise<SnapshotLease[]> {
    let file;
    try {
      file = await open(
        join(this.cache.contentDirectory, "leases.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 131072) throw new Error("Invalid size");
      const bytes = Buffer.alloc(131073);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
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
        throw new Error("Invalid length");
      const saved = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
      if (
        !saved ||
        Object.keys(saved).sort().join(",") !== "binding,leases,version" ||
        saved.version !== 1 ||
        canonicalJson(saved.binding) !== canonicalJson(this.cache.binding) ||
        !Array.isArray(saved.leases) ||
        saved.leases.length > 128
      )
        throw new Error("Invalid binding or shape");
      const leases: SnapshotLease[] = saved.leases.map((item: unknown) =>
        snapshotLeaseSchema.parse(item),
      );
      if (new Set(leases.map((item) => item.token)).size !== leases.length)
        throw new Error("Duplicate lease");
      signal.throwIfAborted();
      return leases;
    } catch (error) {
      signal.throwIfAborted();
      throw new ProtocolError(
        "corrupt_storage",
        "Invalid terminal lease catalog",
      );
    } finally {
      await file.close();
    }
  }
  load(signal: AbortSignal) {
    return this.run(signal, () => this.read(signal));
  }
  save(
    expected: SnapshotLease | null,
    next: SnapshotLease | null,
    signal: AbortSignal,
  ): Promise<void> {
    const previous =
      expected === null ? null : snapshotLeaseSchema.parse(expected);
    const saved = next === null ? null : snapshotLeaseSchema.parse(next);
    if (!previous && !saved)
      return Promise.reject(new RangeError("Missing lease"));
    if (
      previous &&
      saved &&
      (previous.token !== saved.token ||
        canonicalJson(previous.snapshot) !== canonicalJson(saved.snapshot) ||
        saved.expiresAt < previous.expiresAt)
    )
      return Promise.reject(
        new ProtocolError(
          "event_conflict",
          "Terminal lease provenance changed",
        ),
      );
    return this.run(signal, async () => {
      const leases = await this.read(signal),
        token = (saved ?? previous)!.token;
      const current = leases.find((item) => item.token === token) ?? null;
      if (canonicalJson(current) !== canonicalJson(previous))
        throw new ProtocolError(
          "event_conflict",
          "Terminal lease catalog changed",
        );
      const retained = leases.filter((item) => item.token !== token);
      if (saved) retained.push(saved);
      if (retained.length > 128)
        throw new ProtocolError(
          "retry_later",
          "Terminal lease catalog is full",
        );
      signal.throwIfAborted();
      // Once atomic publication begins, drain it even if the caller cancels.
      await atomicJson(join(this.cache.contentDirectory, "leases.json"), {
        version: 1,
        binding: this.cache.binding,
        leases: retained,
      });
    });
  }
  /** Clear the complete import union only after derivative roots are invalidated. */
  clear(
    expected: readonly SnapshotLease[],
    signal: AbortSignal,
  ): Promise<void> {
    if (expected.length > 128) throw new RangeError("Too many snapshot leases");
    const previous = expected.map((lease) => snapshotLeaseSchema.parse(lease));
    if (new Set(previous.map((lease) => lease.token)).size !== previous.length)
      throw new RangeError("Duplicate snapshot lease");
    return this.run(signal, async () => {
      const current = await this.read(signal);
      if (canonicalJson(current) !== canonicalJson(previous))
        throw new ProtocolError(
          "event_conflict",
          "Terminal lease catalog changed during invalidation",
        );
      signal.throwIfAborted();
      await atomicJson(join(this.cache.contentDirectory, "leases.json"), {
        version: 1,
        binding: this.cache.binding,
        leases: [],
      });
    });
  }
  close() {
    return (this.closing ??= this.tail);
  }
}
