import { mkdir, lstat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";
import { PublisherJournal, publisherBindingKey } from "./journal.js";
import { finishJournal, readPublisherOperation } from "./finish.js";

export interface NewStreamReceipt {
  retiredDirectory: string;
  streamId: string | null;
  /** False when the binding was already finished, transferred or never bound. */
  ended: boolean;
}

/**
 * Start a second recording of a native session that already has one: end the
 * existing recording at exactly what it captured, then set its binding aside so the
 * next `publish` creates a fresh binding, recording and viewer URL.
 *
 * This is `finish`, `retire`, `publish` as one step, and each step is the same one
 * those commands run. The finish operation ID is derived from the binding, so an
 * interrupted attempt completes the same operation rather than starting another;
 * once the directory has moved, repeating is a no-op.
 *
 * Returns null when no binding exists yet, which is simply a first publication.
 */
export async function startNewPublisherStream(options: {
  publisherRoot: string;
  binding: {
    serverOrigin: string;
    agent: Parameters<typeof publisherBindingKey>[0]["agent"];
    nativeSessionId: string;
  };
  ownerCredential: string;
  signal: AbortSignal;
}): Promise<NewStreamReceipt | null> {
  const key = publisherBindingKey(options.binding);
  const directory = join(options.publisherRoot, key);
  const present = await lstat(directory).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!present) return null;
  let journal: PublisherJournal;
  try {
    journal = await PublisherJournal.openExisting(directory);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy")
      throw new Error(
        "A publisher process is attached to this binding; stop it before starting a new recording",
      );
    throw error;
  }
  let ended = false;
  try {
    const identity = journal.identity;
    const finished =
      ((await readPublisherOperation(directory, "finish-publish.json")) as
        { completed?: unknown } | undefined) !== undefined;
    const transferred =
      (await readPublisherOperation(directory, "archive-transfer.json")) !==
      undefined;
    if (!finished && !transferred && identity.streamId) {
      if (!identity.sharingEnabled)
        throw new Error(
          "Sharing is paused for this binding; resume it so its recording can be ended, or retire it by hand",
        );
      // Delivering and ending is the same operation `finish` runs, with an ID
      // derived from the binding so a retry completes it instead of repeating it.
      await finishJournal(journal, {
        operationId: createHash("sha256")
          .update(
            canonicalJson({ newStream: key, epoch: identity.producerEpoch }),
          )
          .digest("hex"),
        ownerCredential: options.ownerCredential,
        signal: options.signal,
      });
      ended = true;
    }
    if (identity.acknowledgedSeq !== journal.capturedThrough)
      throw new Error(
        "The binding still has undelivered events; run its publisher until it is caught up, then retry",
      );
    const retiredRoot = join(options.publisherRoot, "retired");
    await mkdir(retiredRoot, { recursive: true, mode: 0o700 });
    const target = join(
      retiredRoot,
      `${key}-${identity.streamId ?? "unbound"}-${Date.now()}`,
    );
    await journal.close();
    await rename(directory, target);
    return { retiredDirectory: target, streamId: identity.streamId, ended };
  } catch (error) {
    await journal.close().catch(() => {});
    throw error;
  }
}
