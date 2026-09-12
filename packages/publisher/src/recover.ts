import { request } from "@agentlive/client/transport";
import { z } from "zod";
import { join } from "node:path";
import { openRecordingHistory } from "@agentlive/client";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";
import { PublisherJournal } from "./journal.js";
import { advancePublisherChain, GENESIS_CHAIN } from "./journal-index.js";
import { ArtifactSpool } from "./artifacts.js";
import { uploadArtifact } from "./artifact-upload.js";

/** Explicit restored-revision recovery; never silently lower an ACK on reconnect. */
export async function recoverPublisher(options: {
  directory: string;
  signal: AbortSignal;
}) {
  const journal = await PublisherJournal.openExisting(options.directory);
  let artifacts: ArtifactSpool | undefined;
  try {
    const identity = journal.identity;
    if (!identity.streamId || !identity.revision)
      throw new Error("Publisher has no remote recording to recover");
    const history = await openRecordingHistory({
      serverOrigin: identity.serverOrigin,
      streamId: identity.streamId,
      credential: identity.writeSecret,
      signal: options.signal,
    });
    if (history.metadata.revision === identity.revision)
      throw new Error(
        "Recording revision is unchanged; normal publisher resume applies",
      );
    const checkRemote = async () => {
      const response = await request(
        fetch,
        `${identity.serverOrigin}/api/v1/streams/${identity.streamId}/publisher-state`,
        { headers: { authorization: `Bearer ${identity.writeSecret}` } },
        options.signal,
        32768,
      );
      const current = z
        .object({
          revision: z.string(),
          publisherId: z.string(),
          producerEpoch: z.string(),
          serverSeq: z.number().int(),
        })
        .parse(JSON.parse(response.text));
      if (
        current.revision !== history.metadata.revision ||
        current.publisherId !== identity.publisherId ||
        current.producerEpoch !== identity.producerEpoch ||
        current.serverSeq !== history.metadata.serverSeq
      )
        throw new ProtocolError(
          "event_conflict",
          "Recording identity or boundary changed during publisher recovery",
        );
    };
    await checkRemote();
    // Records at or before `compactedThrough` were pruned after acknowledgement.
    // Their events survive only as the running hash chain, so the restored
    // prefix is verified against that chain up to the compaction boundary and
    // event-by-event from there on.
    const compactedThrough = journal.compactedThrough;
    const local = journal.pending(compactedThrough);
    let through = 0;
    let chain = GENESIS_CHAIN;
    let chainVerified = compactedThrough === 0;
    const divergent = () =>
      new ProtocolError(
        "event_conflict",
        "Restored publisher history differs from the local journal",
      );
    try {
      for await (const stored of history.events) {
        options.signal.throwIfAborted();
        if (stored.origin.type !== "publisher") continue;
        const event = stored.origin.event;
        if (
          event.producerEpoch !== identity.producerEpoch ||
          event.streamId !== identity.streamId ||
          event.producerSeq !== through + 1
        )
          throw divergent();
        if (event.producerSeq <= compactedThrough) {
          chain = advancePublisherChain(chain, event);
          if (event.producerSeq === compactedThrough) {
            if (chain !== journal.compactedChain) throw divergent();
            chainVerified = true;
          }
        } else {
          const next = await local.next();
          if (next.done || canonicalJson(next.value) !== canonicalJson(event))
            throw divergent();
        }
        through = event.producerSeq;
      }
    } finally {
      await local.return(undefined);
    }
    if (!chainVerified)
      throw new ProtocolError(
        "sequence_gap",
        "Restored publisher history ends inside locally compacted history and cannot be verified",
        { compactedThrough, restoredThroughProducerSeq: through },
      );
    // A restored server may lack attachments referenced only by the lost suffix.
    // Re-upload immutable spool bytes before committing the new delivery cursor.
    let uploaded = 0;
    for await (const event of journal.pending(through)) {
      options.signal.throwIfAborted();
      if (event.content.kind !== "attachment.available") continue;
      artifacts ??= await ArtifactSpool.open(
        join(journal.directory, "artifacts", "capture"),
        { allowedRoots: [] },
      );
      await uploadArtifact(artifacts, event.content.payload.attachment, {
        serverOrigin: identity.serverOrigin,
        streamId: identity.streamId,
        writeSecret: identity.writeSecret,
        signal: options.signal,
      });
      uploaded++;
    }
    options.signal.throwIfAborted();
    await checkRemote();
    await journal.recoverRevision(
      identity.revision,
      history.metadata.revision,
      through,
    );
    return {
      streamId: identity.streamId,
      previousRevision: identity.revision,
      revision: history.metadata.revision,
      previousAcknowledgedSeq: identity.acknowledgedSeq,
      acknowledgedSeq: through,
      /** Leading events verified only by the compacted hash chain, not record-by-record. */
      chainVerifiedThrough: compactedThrough,
      pendingEvents: journal.capturedThrough - through,
      uploadedAttachments: uploaded,
      lifecycle: history.metadata.lifecycle,
    };
  } finally {
    try {
      await artifacts?.close();
    } finally {
      await journal.close();
    }
  }
}
