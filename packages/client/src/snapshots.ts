import { z } from "zod";
import {
  ProtocolError,
  canonicalJson,
  idSchema,
  cursorSchema,
  snapshotSelectionSchema,
  snapshotLeaseSelectionSchema,
  snapshotLeaseSchema,
  snapshotLeaseTokenSchema,
  type SnapshotLease,
  snapshotContentReferenceSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import {
  openRecordingSnapshot,
  type ContentReference,
} from "@agentlive/playback";
import { originOf, request } from "./http.js";
/** Optional derivative range cache; keys include origin, recording revision and complete range identity. */
export interface SnapshotReadCache {
  read(key: string, signal: AbortSignal): Promise<string | undefined>;
  write(key: string, text: string, signal: AbortSignal): Promise<void>;
}
export interface OpenedSnapshot {
  descriptor: SnapshotDescriptor;
  reader: Awaited<ReturnType<typeof openRecordingSnapshot>>;
}
/** Session-scoped, bounded HTTP transport. Readers share their opening operation's lifetime signal. */
export class RecordingSnapshotClient {
  private readonly base: string;
  private readonly streamId: string;
  private readonly revision: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly stop = new AbortController();
  private pending = 0;
  private blobPending = 0;
  private cache: SnapshotReadCache | undefined;
  constructor(options: {
    serverOrigin: string;
    streamId: string;
    revision: string;
    credential?: string;
    fetch?: typeof fetch;
    cache?: SnapshotReadCache;
  }) {
    this.streamId = idSchema.parse(options.streamId);
    this.revision = idSchema.parse(options.revision);
    this.base = `${originOf(options.serverOrigin)}/api/v1/streams/${this.streamId}`;
    this.headers = options.credential
      ? { authorization: `Bearer ${options.credential}` }
      : {};
    this.fetcher = options.fetch ?? fetch;
    this.cache = options.cache;
  }
  private signal(signal: AbortSignal) {
    return AbortSignal.any([this.stop.signal, signal]);
  }
  private async json(
    path: string,
    signal: AbortSignal,
    maximum: number,
    body?: unknown,
    method?: "DELETE",
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.pending >= 16)
      throw new ProtocolError(
        "retry_later",
        "Snapshot requests are at capacity",
      );
    this.pending++;
    try {
      const response = await request(
        this.fetcher,
        this.base + path,
        {
          headers: {
            ...this.headers,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined
            ? {}
            : { method: "POST", body: JSON.stringify(body) }),
          ...(method ? { method } : {}),
        },
        signal,
        maximum,
      );
      signal.throwIfAborted();
      if (method === "DELETE") {
        if (response.text !== "")
          throw new ProtocolError(
            "invalid_request",
            "Invalid snapshot release response",
          );
        return null;
      }
      try {
        return JSON.parse(response.text);
      } catch {
        throw new ProtocolError(
          "invalid_request",
          "Invalid snapshot response JSON",
        );
      }
    } finally {
      this.pending--;
    }
  }
  private async open(
    raw: unknown,
    through: number,
    exact: boolean,
    signal: AbortSignal,
    timelineMs?: number,
    leaseToken?: string,
  ): Promise<OpenedSnapshot | null> {
    const result = snapshotSelectionSchema.safeParse(raw);
    if (!result.success)
      throw new ProtocolError(
        "invalid_request",
        "Invalid snapshot selection response",
      );
    const envelope = result.data;
    if (
      envelope.streamId !== this.streamId ||
      envelope.revision !== this.revision
    )
      throw new ProtocolError(
        "revision_changed",
        "Snapshot response binding changed",
      );
    const descriptor = envelope.snapshot;
    if (!descriptor) {
      if (exact)
        throw new ProtocolError(
          "invalid_request",
          "Snapshot publication returned no descriptor",
        );
      return null;
    }
    if (
      (timelineMs !== undefined && descriptor.timelineMs > timelineMs) ||
      descriptor.serverSeq > through ||
      (exact && descriptor.serverSeq !== through)
    )
      throw new ProtocolError(
        "sequence_gap",
        "Snapshot response is outside the requested boundary",
      );
    const reader = await openRecordingSnapshot(
      descriptor,
      { streamId: this.streamId, revision: this.revision },
      {
        put: async () => {
          throw new Error("Snapshot HTTP reader is read-only");
        },
        read: (ref, offset, length, readSignal) =>
          this.read(
            ref,
            offset,
            length,
            readSignal ? AbortSignal.any([signal, readSignal]) : signal,
            leaseToken,
          ),
      },
      signal,
    );
    if (
      reader.manifest.serverSeq !== descriptor.serverSeq ||
      reader.manifest.timelineMs !== descriptor.timelineMs
    )
      throw new ProtocolError(
        "corrupt_storage",
        "Snapshot descriptor boundary differs from manifest",
      );
    Object.freeze(descriptor.ref);
    if (descriptor.activity) Object.freeze(descriptor.activity);
    Object.freeze(descriptor);
    return { descriptor, reader };
  }
  private cacheOperation<T>(
    parent: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation(signal);
        })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  private async read(
    ref: ContentReference,
    offset: number,
    length: number,
    signal: AbortSignal,
    leaseToken?: string,
  ): Promise<string> {
    ref = snapshotContentReferenceSchema.parse(ref);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 65536 ||
      offset > ref.units ||
      length > ref.units - offset
    )
      throw new RangeError("Invalid snapshot content range");
    signal.throwIfAborted();
    const cacheKey = canonicalJson({
      base: this.base,
      revision: this.revision,
      ref,
      offset,
      length,
    });
    if (this.cache) {
      try {
        const cache = this.cache;
        const text = await this.cacheOperation(signal, (cacheSignal) =>
          cache.read(cacheKey, cacheSignal),
        );
        signal.throwIfAborted();
        if (typeof text === "string" && text.length === length) return text;
      } catch {
        signal.throwIfAborted();
        this.cache = undefined;
      }
    }
    const query = new URLSearchParams({
      revision: this.revision,
      byteSize: String(ref.byteSize),
      units: String(ref.units),
      offset: String(offset),
      length: String(length),
    });
    if (leaseToken !== undefined) query.set("lease", leaseToken);
    const raw = await this.json(
      `/snapshot-content/${ref.hash}?${query}`,
      signal,
      length * 6 + 4096,
    );
    const result = z.strictObject({ text: z.string() }).safeParse(raw);
    // Protocol ranges count UTF-16 units; schema string lengths count code points.
    if (!result.success || result.data.text.length !== length)
      throw new ProtocolError(
        "corrupt_storage",
        "Snapshot content response has invalid shape or length",
      );
    if (this.cache) {
      try {
        const cache = this.cache;
        await this.cacheOperation(signal, (cacheSignal) =>
          cache.write(cacheKey, result.data.text, cacheSignal),
        );
      } catch {
        signal.throwIfAborted();
        this.cache = undefined;
      }
    }
    signal.throwIfAborted();
    return result.data.text;
  }
  /** Exact codec bytes, bounded to one blob and verified before use by a local content backend. */
  async readBlob(
    reference: ContentReference,
    parent: AbortSignal,
    leaseToken?: string,
  ): Promise<Uint8Array> {
    const ref = snapshotContentReferenceSchema.parse(reference),
      signal = this.signal(parent);
    if (leaseToken !== undefined) snapshotLeaseTokenSchema.parse(leaseToken);
    signal.throwIfAborted();
    if (this.blobPending >= 16)
      throw new ProtocolError(
        "retry_later",
        "Snapshot blob requests are at capacity",
      );
    this.blobPending++;
    try {
      const encodedLength = 4 * Math.ceil(ref.byteSize / 3);
      const query = new URLSearchParams({
        revision: this.revision,
        byteSize: String(ref.byteSize),
        units: String(ref.units),
      });
      if (leaseToken !== undefined) query.set("lease", leaseToken);
      const raw = await this.json(
        `/snapshot-blobs/${ref.hash}?${query}`,
        signal,
        encodedLength + 4096,
      );
      const parsed = z.strictObject({ base64: z.string() }).safeParse(raw);
      if (!parsed.success || parsed.data.base64.length !== encodedLength)
        throw new ProtocolError(
          "corrupt_storage",
          "Invalid snapshot blob response",
        );
      let bytes: Uint8Array;
      try {
        const decoded = atob(parsed.data.base64);
        if (decoded.length !== ref.byteSize) throw new Error("length");
        bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index++)
          bytes[index] = decoded.charCodeAt(index);
      } catch {
        throw new ProtocolError(
          "corrupt_storage",
          "Invalid snapshot blob encoding",
        );
      }
      signal.throwIfAborted();
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            bytes as Uint8Array<ArrayBuffer>,
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      signal.throwIfAborted();
      if (hash !== ref.hash)
        throw new ProtocolError(
          "corrupt_storage",
          "Snapshot blob checksum differs",
        );
      return bytes;
    } finally {
      this.blobPending--;
    }
  }
  private leaseResponse(raw: unknown): SnapshotLease | null {
    const parsed = snapshotLeaseSelectionSchema.safeParse(raw);
    if (!parsed.success)
      throw new ProtocolError(
        "invalid_request",
        "Invalid snapshot lease response",
      );
    if (
      parsed.data.streamId !== this.streamId ||
      parsed.data.revision !== this.revision
    )
      throw new ProtocolError(
        "revision_changed",
        "Snapshot lease binding changed",
      );
    const lease = parsed.data.lease;
    if (lease) {
      Object.freeze(lease.snapshot.ref);
      Object.freeze(lease.snapshot.activity);
      Object.freeze(lease.snapshot);
      Object.freeze(lease);
    }
    return lease;
  }
  /** Acquire durable retention before adopting a remote descriptor. Caller persists
   * provenance and renews/releases the lease for the lifetime of its lazy readers.
   */
  async acquireLease(
    throughServerSeq: number,
    parent: AbortSignal,
    timelineMs?: number,
  ): Promise<SnapshotLease | null> {
    const through = cursorSchema.parse(throughServerSeq);
    if (timelineMs !== undefined)
      z.number().finite().nonnegative().parse(timelineMs);
    const signal = this.signal(parent);
    const lease = this.leaseResponse(
      await this.json("/snapshot-leases", signal, 4096, {
        revision: this.revision,
        throughServerSeq: through,
        ...(timelineMs === undefined ? {} : { timelineMs }),
      }),
    );
    if (
      lease &&
      (lease.snapshot.serverSeq > through ||
        (timelineMs !== undefined && lease.snapshot.timelineMs > timelineMs))
    )
      throw new ProtocolError(
        "sequence_gap",
        "Snapshot lease is outside the requested boundary",
      );
    return lease;
  }
  /** Open retained roots with the lease carried by every uncached range request.
   * The caller owns renewal and release; local cached ranges remain usable offline.
   */
  async openLease(
    previous: SnapshotLease,
    parent: AbortSignal,
  ): Promise<OpenedSnapshot> {
    const lease = snapshotLeaseSchema.parse(previous),
      signal = this.signal(parent);
    return (await this.open(
      {
        streamId: this.streamId,
        revision: this.revision,
        snapshot: lease.snapshot,
      },
      lease.snapshot.serverSeq,
      true,
      signal,
      lease.snapshot.timelineMs,
      lease.token,
    ))!;
  }
  async renewLease(
    previous: SnapshotLease,
    parent: AbortSignal,
  ): Promise<SnapshotLease> {
    const saved = snapshotLeaseSchema.parse(previous),
      signal = this.signal(parent);
    const lease = this.leaseResponse(
      await this.json(`/snapshot-leases/${saved.token}/renew`, signal, 4096, {
        revision: this.revision,
      }),
    );
    if (
      !lease ||
      lease.token !== saved.token ||
      canonicalJson(lease.snapshot) !== canonicalJson(saved.snapshot) ||
      lease.expiresAt < saved.expiresAt
    )
      throw new ProtocolError(
        "invalid_request",
        "Snapshot lease renewal changed retained roots or lifetime",
      );
    return lease;
  }
  async releaseLease(
    previous: SnapshotLease,
    parent: AbortSignal,
  ): Promise<void> {
    const saved = snapshotLeaseSchema.parse(previous),
      signal = this.signal(parent);
    const query = new URLSearchParams({ revision: this.revision });
    await this.json(
      `/snapshot-leases/${saved.token}?${query}`,
      signal,
      4096,
      undefined,
      "DELETE",
    );
  }
  async select(
    throughServerSeq: number,
    signal: AbortSignal,
    timelineMs?: number,
  ): Promise<OpenedSnapshot | null> {
    if (timelineMs !== undefined)
      z.number().finite().nonnegative().parse(timelineMs);
    const through = cursorSchema.parse(throughServerSeq),
      combined = this.signal(signal);
    const query = new URLSearchParams({
      revision: this.revision,
      throughServerSeq: String(through),
    });
    if (timelineMs !== undefined) query.set("timelineMs", String(timelineMs));
    const selected = await this.open(
      await this.json(`/snapshots?${query}`, combined, 4096),
      through,
      false,
      combined,
      timelineMs,
    );
    return selected;
  }
  async publish(
    throughServerSeq: number,
    signal: AbortSignal,
  ): Promise<OpenedSnapshot> {
    const through = cursorSchema.parse(throughServerSeq),
      combined = this.signal(signal);
    return (await this.open(
      await this.json("/snapshots", combined, 4096, {
        revision: this.revision,
        throughServerSeq: through,
      }),
      through,
      true,
      combined,
    ))!;
  }
  /** Stops outstanding and future transport requests, including requests from existing readers. */
  close(): void {
    this.stop.abort(new Error("Snapshot client is closed"));
  }
}
