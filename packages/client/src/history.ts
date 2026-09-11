import { z } from "zod";
import {
  idSchema,
  cursorSchema,
  storedEventSchema,
  ProtocolError,
  type StoredEvent,
} from "@agentlive/protocol";
import { request, originOf, retryable, delay } from "./http.js";
/** Fixed-boundary history download. New live events cannot extend this replay mid-read. */
export async function openRecordingHistory(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  options = { ...options };
  const base = `${originOf(options.serverOrigin)}/api/v1/streams/${idSchema.parse(options.streamId)}`;
  const headers = options.credential
    ? { authorization: `Bearer ${options.credential}` }
    : {};
  const fetcher = options.fetch ?? fetch;
  const get = async (url: string, signal = options.signal) => {
    let attempts = 0;
    while (true) {
      try {
        return await request(fetcher, url, { headers }, signal);
      } catch (error) {
        if (signal.aborted || !retryable(error)) throw error;
        await delay(
          Math.min(30000, 250 * 2 ** Math.min(attempts++, 7)),
          signal,
        );
      }
    }
  };
  const metadata = z
    .object({
      revision: idSchema,
      serverSeq: cursorSchema,
      title: z.string(),
      lifecycle: z.enum(["open", "ended"]),
    })
    .parse(JSON.parse((await get(base)).text));
  async function* events(
    range: {
      afterServerSeq?: number;
      throughServerSeq?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<StoredEvent> {
    let after = cursorSchema.parse(range.afterServerSeq ?? 0);
    const through = cursorSchema.parse(
      range.throughServerSeq ?? metadata.serverSeq,
    );
    if (after > through || through > metadata.serverSeq)
      throw new RangeError("History range exceeds its captured boundary");
    const signal = range.signal
      ? AbortSignal.any([options.signal, range.signal])
      : options.signal;
    signal.throwIfAborted();
    while (after < through) {
      const url = new URL(base + "/events");
      url.searchParams.set("revision", metadata.revision);
      url.searchParams.set("throughServerSeq", String(through));
      url.searchParams.set("afterServerSeq", String(after));
      url.searchParams.set("limit", "500");
      const { response, text } = await get(url.toString(), signal);
      if (
        response.headers.get("x-agentlive-revision") !== metadata.revision ||
        response.headers.get("x-agentlive-through") !== String(through) ||
        !text.endsWith("\n")
      )
        throw new ProtocolError(
          "resync_required",
          "History boundary or framing changed",
        );
      const page = text
        .slice(0, -1)
        .split("\n")
        .map((line) => storedEventSchema.parse(JSON.parse(line)));
      let cursor = after;
      for (const event of page) {
        if (event.serverSeq !== ++cursor || cursor > through)
          throw new ProtocolError(
            "sequence_gap",
            "History page is not contiguous",
          );
      }
      if (
        !page.length ||
        response.headers.get("x-agentlive-next-cursor") !== String(cursor) ||
        response.headers.get("x-agentlive-complete") !==
          String(cursor === through)
      )
        throw new ProtocolError(
          "sequence_gap",
          "History page has an invalid receipt cursor",
        );
      for (const event of page) {
        signal.throwIfAborted();
        yield event;
      }
      after = cursor;
    }
  }
  return { metadata: { ...metadata }, events: events(), range: events };
}
