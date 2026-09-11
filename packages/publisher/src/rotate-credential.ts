import { z } from "zod";
import { request } from "@agentlive/client/transport";
import { PublisherJournal } from "./journal.js";

/** Keep the old key plus a durable replacement until the idempotent server operation confirms. */
export async function rotatePublisherCredential(options: {
  directory: string;
  ownerCredential: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  restart?: boolean;
}) {
  const journal = await PublisherJournal.openExisting(options.directory);
  try {
    const identity = journal.identity;
    if (!identity.streamId || !identity.revision)
      throw new Error("Publisher has no remote recording to rotate");
    const endpoint = `${identity.serverOrigin}/api/v1/streams/${identity.streamId}/publisher-credential`;
    const schema = z.object({
      streamId: z.literal(identity.streamId),
      revision: z.literal(identity.revision),
      publisherId: z.literal(identity.publisherId),
      producerEpoch: z.literal(identity.producerEpoch),
      version: z.number().int().nonnegative().safe(),
      revoked: z.boolean(),
    });
    const call = async (body?: unknown) => {
      const response = await request(
        options.fetch ?? fetch,
        endpoint,
        {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${options.ownerCredential}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        options.signal,
        32768,
      );
      return schema.parse(JSON.parse(response.text));
    };
    const state = await call();
    const pending = await journal.prepareCredentialRotation(
      state.version,
      options.restart,
    );
    const changed = await call(pending);
    if (changed.revoked || changed.version !== pending.expectedVersion + 1)
      throw new Error("Publisher credential confirmation differs");
    await journal.confirmCredentialRotation(pending.operationId);
    return changed;
  } finally {
    await journal.close();
  }
}
