import { z } from "zod";
import { idSchema, cursorSchema } from "@agentlive/protocol";
import { originOf, request } from "@agentlive/client/transport";
export async function publisherCredential(options: {
  serverOrigin: string;
  streamId: string;
  credential: string;
  signal: AbortSignal;
  revoke?: { operationId: string; revision: string; expectedVersion: number };
}) {
  const streamId = idSchema.parse(options.streamId);
  const revoke =
    options.revoke &&
    z
      .strictObject({
        operationId: idSchema,
        revision: idSchema,
        expectedVersion: cursorSchema,
      })
      .parse(options.revoke);
  const response = await request(
    fetch,
    `${originOf(options.serverOrigin)}/api/v1/streams/${streamId}/publisher-credential`,
    {
      method: revoke ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${options.credential}`,
        ...(revoke ? { "content-type": "application/json" } : {}),
      },
      ...(revoke
        ? { body: JSON.stringify({ ...revoke, replacementSecret: null }) }
        : {}),
    },
    options.signal,
    32768,
  );
  const state = z
    .object({
      streamId: z.literal(streamId),
      revision: idSchema,
      publisherId: idSchema,
      producerEpoch: idSchema,
      version: cursorSchema,
      revoked: z.boolean(),
    })
    .parse(JSON.parse(response.text));
  if (
    revoke &&
    (state.revision !== revoke.revision ||
      state.version !== revoke.expectedVersion + 1 ||
      !state.revoked)
  )
    throw new Error("Publisher revocation confirmation differs");
  return state;
}
