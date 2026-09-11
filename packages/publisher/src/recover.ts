import { request } from "@agentlive/client/transport";
import { z } from "zod";
import { join } from "node:path";
import { openRecordingHistory } from "@agentlive/client";
import { canonicalJson, ProtocolError } from "@agentlive/protocol";
import { PublisherJournal } from "./journal.js";
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
    const local = journal.pending(0);
    let through = 0;
    try {
      for await (const stored of history.events) {
        options.signal.throwIfAborted();
        if (stored.origin.type !== "publisher") continue;
        const event = stored.origin.event;
        const next = await local.next();
        if (
          event.producerEpoch !== identity.producerEpoch ||
          event.streamId !== identity.streamId ||
          event.producerSeq !== through + 1 ||
          next.done ||
          canonicalJson(next.value) !== canonicalJson(event)
        )
          throw new ProtocolError(
            "event_conflict",
            "Restored publisher history differs from the local journal",
          );
        through = event.producerSeq;
      }
    } finally {
      await local.return(undefined);
    }
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
