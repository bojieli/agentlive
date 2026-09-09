import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  idSchema,
  storedEventSchema,
  type StoredEvent,
} from "@agentlive/protocol";
import { atomicJson } from "./atomic.js";
import { FileLock } from "./lock.js";
import { JsonlLog } from "./log.js";
/** The durable event prefix is the receipt cursor; no separately updated cursor file. */
export class SubscriberCache {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly log: JsonlLog<StoredEvent>,
    private readonly lock: FileLock,
    readonly binding: Readonly<{
      serverOrigin: string;
      streamId: string;
      revision: string;
    }>,
    private readonly maxBytes: number,
  ) {}
  static async open(
    root: string,
    options: {
      serverOrigin: string;
      streamId: string;
      initialize: () => Promise<{ revision: string }>;
      maxBytes?: number;
    },
  ): Promise<SubscriberCache> {
    const serverOrigin = new URL(options.serverOrigin).origin;
    const streamId = idSchema.parse(options.streamId);
    const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid subscriber cache limit");
    const directory = join(
      root,
      createHash("sha256")
        .update(canonicalJson({ serverOrigin, streamId }))
        .digest("hex"),
    );
    const lock = await FileLock.acquire(join(directory, "cache.lock"));
    let log: JsonlLog<StoredEvent> | undefined;
    try {
      const manifestPath = join(directory, "recording.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const existing = await stat(join(directory, "events.jsonl")).catch(
          (error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (existing && existing.size > 0)
          throw new Error(
            "Subscriber cache manifest is missing; explicit recovery is required",
          );
        manifest = {
          version: 1,
          serverOrigin,
          streamId,
          revision: idSchema.parse((await options.initialize()).revision),
        };
        await atomicJson(manifestPath, manifest);
      }
      if (
        manifest.version !== 1 ||
        manifest.serverOrigin !== serverOrigin ||
        manifest.streamId !== streamId
      )
        throw new Error("Subscriber cache identity mismatch");
      const revision = idSchema.parse(manifest.revision);
      log = await JsonlLog.open(join(directory, "events.jsonl"), {
        parse: (value) => storedEventSchema.parse(value),
      });
      if (log.boundary.byteOffset > maxBytes)
        throw new Error("Subscriber cache exceeds its storage limit");
      for await (const entry of log.read()) {
        if (entry.value.serverSeq !== entry.sequence)
          throw new Error("Subscriber cache sequence mismatch");
      }
      return new SubscriberCache(
        log,
        lock,
        Object.freeze({ serverOrigin, streamId, revision }),
        maxBytes,
      );
    } catch (error) {
      await log?.close();
      await lock.release();
      throw error;
    }
  }
  get cursor() {
    return { ...this.binding, serverSeq: this.log.boundary.sequence };
  }
  async *events() {
    for await (const entry of this.log.read()) yield entry.value;
  }
  commit(
    events: readonly StoredEvent[],
    cursor: { streamId: string; revision: string; serverSeq: number },
  ): Promise<void> {
    const copied = events.map((event) => storedEventSchema.parse(event));
    const receipt = { ...cursor };
    const work = this.tail.then(async () => {
      if (
        receipt.streamId !== this.binding.streamId ||
        receipt.revision !== this.binding.revision
      )
        throw new Error("Subscriber cache revision changed");
      let sequence = this.log.boundary.sequence;
      for (const event of copied)
        if (event.serverSeq !== ++sequence)
          throw new Error("Subscriber cache commit is not contiguous");
      if (sequence !== receipt.serverSeq)
        throw new Error("Subscriber cache receipt does not match events");
      // Include the JSONL envelope and hash overhead, conservatively, before allocating append buffers.
      const added = copied.reduce(
        (total, event) => total + Buffer.byteLength(canonicalJson(event)) + 256,
        0,
      );
      if (this.log.boundary.byteOffset + added > this.maxBytes)
        throw new Error("Subscriber cache storage limit reached");
      await this.log.append(copied);
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async close() {
    await this.tail;
    try {
      await this.log.close();
    } finally {
      await this.lock.release();
    }
  }
}
