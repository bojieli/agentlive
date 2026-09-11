import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delay } from "@agentlive/client/transport";
import {
  readJsonlSource,
  type SourceCursor,
  type SourceRecord,
} from "./jsonl.js";
export interface FollowJsonlOptions {
  signal: AbortSignal;
  after?: SourceCursor;
  pollMs?: number;
  maxRecordBytes?: number;
  /** Await related-source capture on every poll, including when this file is idle. */
  onScan?: (finishing: boolean) => Promise<void>;
  finishRequested?: () => boolean;
  /** Commit normalized effects and this source cursor durably before resolving. */
  commit(record: SourceRecord): Promise<void>;
  /** A fixed initial byte boundary has been read; an incomplete suffix remains deferred. */
  onCaughtUp?(boundary: {
    through: number;
    cursor: SourceCursor;
  }): Promise<void>;
}
/** Backfill then follow one append-only native file. Replacement requires explicit reconciliation. */
export async function followJsonlSource(
  path: string,
  options: FollowJsonlOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60000)
    throw new RangeError("Invalid source polling interval");
  let cursor = options.after
    ? { ...options.after }
    : { offset: 0, prefixHash: createHash("sha256").digest("hex") };
  let previous: Awaited<ReturnType<typeof stat>> | undefined;
  let caughtUp = false;
  while (true) {
    options.signal.throwIfAborted();
    const finishing = options.finishRequested?.() ?? false;
    await options.onScan?.(finishing);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Source is not a regular file");
    if (
      previous &&
      (info.dev !== previous.dev ||
        info.ino !== previous.ino ||
        info.size < previous.size)
    )
      throw new Error(
        "Source replaced or truncated; explicit reconciliation is required",
      );
    if (
      !previous ||
      info.size !== previous.size ||
      info.mtimeMs !== previous.mtimeMs ||
      info.ctimeMs !== previous.ctimeMs
    ) {
      // The reader verifies the acknowledged prefix before accepting newly appended effects.
      for await (const record of readJsonlSource(path, {
        after: cursor,
        through: info.size,
        tail: "defer",
        signal: options.signal,
        ...(options.maxRecordBytes === undefined
          ? {}
          : { maxRecordBytes: options.maxRecordBytes }),
      })) {
        options.signal.throwIfAborted();
        const next = { ...record.cursor };
        await options.commit(record);
        cursor = next;
      }
      const afterRead = await stat(path);
      if (
        info.dev !== afterRead.dev ||
        info.ino !== afterRead.ino ||
        afterRead.size < info.size
      )
        throw new Error("Source replaced or truncated during catch-up");
      previous = info;
      if (!caughtUp) {
        await options.onCaughtUp?.({
          through: info.size,
          cursor: { ...cursor },
        });
        caughtUp = true;
      }
    }
    if (finishing) {
      if (cursor.offset !== info.size)
        throw new Error(
          "Native source has an incomplete final record; recovery required",
        );
      return;
    }
    await delay(pollMs, options.signal);
  }
}
