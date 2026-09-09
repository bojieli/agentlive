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
/** Owner-only discovery. Listing does not imply publisher or subscriber attachment. */
export async function listRecordings(options: {
  serverOrigin: string;
  credential: string;
  signal: AbortSignal;
  after?: string;
  limit?: number;
}) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Listing limit must be from 1 to 100");
  const after =
    options.after === undefined ? undefined : idSchema.parse(options.after);
  const url = new URL("/api/v1/streams", originOf(options.serverOrigin));
  url.searchParams.set("limit", String(limit));
  if (after !== undefined) url.searchParams.set("after", after);
  const response = await request(
    fetch,
    url.href,
    { headers: { authorization: `Bearer ${options.credential}` } },
    options.signal,
  );
  const page = pageSchema.parse(JSON.parse(response.text));
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
