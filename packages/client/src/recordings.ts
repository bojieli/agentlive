import { z } from "zod";
import { idSchema } from "@agentlive/protocol";
import { request, originOf } from "./http.js";
const pageSchema = z.strictObject({
  recordings: z
    .array(
      z.strictObject({
        id: idSchema,
        revision: idSchema,
        title: z.string().max(500),
        visibility: z.enum(["public", "unlisted", "private"]),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100),
  nextAfter: idSchema.nullable(),
});
/** Owned or explicitly public discovery. Listing does not attach to playback. */
export async function listRecordings(options: {
  serverOrigin: string;
  credential: string;
  public?: boolean;
  fetch?: typeof fetch;
  signal: AbortSignal;
  after?: string;
  limit?: number;
}) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Listing limit must be from 1 to 100");
  const after =
    options.after === undefined ? undefined : idSchema.parse(options.after);
  const url = new URL(
    options.public ? "/api/v1/public-recordings" : "/api/v1/streams",
    originOf(options.serverOrigin),
  );
  url.searchParams.set("limit", String(limit));
  if (after !== undefined) url.searchParams.set("after", after);
  const response = await request(
    options.fetch ?? fetch,
    url.href,
    {
      headers:
        options.credential && !options.public
          ? { authorization: `Bearer ${options.credential}` }
          : {},
    },
    options.signal,
  );
  const page = pageSchema.parse(JSON.parse(response.text));
  if (
    options.public &&
    page.recordings.some((recording) => recording.visibility !== "public")
  )
    throw new Error("Public listing contains nonpublic recording");
  let previous = after;
  for (const recording of page.recordings) {
    if (previous !== undefined && recording.id <= previous)
      throw new Error("Recording listing is not ordered");
    previous = recording.id;
  }
  if (
    page.recordings.length > limit ||
    (page.nextAfter !== null &&
      (!page.recordings.length || page.nextAfter !== previous))
  )
    throw new Error("Invalid recording listing cursor");
  return page;
}

/** Remove from service with a caller-retained operation identity for retries. */
export async function removeRecording(options: {
  serverOrigin: string;
  streamId: string;
  revision: string;
  operationId: string;
  expectedServerSeq?: number;
  credential: string;
  fetch?: typeof fetch;
  signal: AbortSignal;
}) {
  const streamId = idSchema.parse(options.streamId);
  const input = {
    revision: idSchema.parse(options.revision),
    operationId: idSchema.parse(options.operationId),
    ...(options.expectedServerSeq === undefined
      ? {}
      : {
          expectedServerSeq: z
            .number()
            .int()
            .nonnegative()
            .safe()
            .parse(options.expectedServerSeq),
        }),
  };
  const response = await request(
    options.fetch ?? fetch,
    `${originOf(options.serverOrigin)}/api/v1/recordings/${encodeURIComponent(streamId)}/removal`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.credential
          ? { authorization: `Bearer ${options.credential}` }
          : {}),
      },
      body: JSON.stringify(input),
    },
    options.signal,
    4096,
  );
  return z
    .strictObject({
      streamId: z.literal(streamId),
      removed: z.literal(true),
      removedAt: z.number().int().nonnegative().safe(),
    })
    .parse(JSON.parse(response.text));
}
