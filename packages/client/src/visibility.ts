import { z } from "zod";
import { idSchema } from "@agentlive/protocol";
import { request, originOf } from "./http.js";

const stateSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  visibility: z.enum(["public", "unlisted", "private"]),
  version: z.number().int().nonnegative().safe(),
});
export type VisibilityState = z.infer<typeof stateSchema>;

const visibilityUrl = (serverOrigin: string, streamId: string) =>
  `${originOf(serverOrigin)}/api/v1/streams/${encodeURIComponent(idSchema.parse(streamId))}/visibility`;

/** Owner-only current visibility, including the version a change must expect. */
export async function readVisibility(options: {
  serverOrigin: string;
  streamId: string;
  credential: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<VisibilityState> {
  const response = await request(
    options.fetch ?? fetch,
    visibilityUrl(options.serverOrigin, options.streamId),
    { headers: { authorization: `Bearer ${options.credential}` } },
    options.signal,
    4096,
  );
  return stateSchema.parse(JSON.parse(response.text));
}

/**
 * Owner-only visibility change. The caller supplies the revision and the
 * version it observed, so a concurrent change is rejected instead of
 * overwritten, and a repeated operation ID is idempotent.
 */
export async function changeVisibility(options: {
  serverOrigin: string;
  streamId: string;
  credential: string;
  revision: string;
  expectedVersion: number;
  operationId: string;
  visibility: "public" | "unlisted" | "private";
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<VisibilityState> {
  const response = await request(
    options.fetch ?? fetch,
    visibilityUrl(options.serverOrigin, options.streamId),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: idSchema.parse(options.revision),
        operationId: idSchema.parse(options.operationId),
        expectedVersion: options.expectedVersion,
        visibility: options.visibility,
      }),
    },
    options.signal,
    4096,
  );
  return stateSchema.parse(JSON.parse(response.text));
}
