import { z } from "zod";
import {
  ProtocolError,
  canonicalJson,
  idSchema,
  cursorSchema,
  snapshotSelectionSchema,
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
        },
        signal,
        maximum,
      );
      signal.throwIfAborted();
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
  async select(
    throughServerSeq: number,
    signal: AbortSignal,
  ): Promise<OpenedSnapshot | null> {
    const through = cursorSchema.parse(throughServerSeq),
      combined = this.signal(signal);
    const query = new URLSearchParams({
      revision: this.revision,
      throughServerSeq: String(through),
    });
    return this.open(
      await this.json(`/snapshots?${query}`, combined, 4096),
      through,
      false,
      combined,
    );
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
