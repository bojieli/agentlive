import {
  openRecordingHistory,
  SubscriberClient,
  type SubscriberStatus,
} from "@agentlive/client";
import { SubscriberCache } from "@agentlive/storage";
import { initialState, apply, renderTerminalEvent } from "@agentlive/playback";
import { originOf } from "@agentlive/client/transport";
export async function watchRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  cacheRoot: string;
  signal: AbortSignal;
  write?: (text: string) => Promise<void>;
  onStatus?: (status: SubscriberStatus) => void;
}) {
  const origin = originOf(options.serverOrigin);
  const cache = await SubscriberCache.open(options.cacheRoot, {
    serverOrigin: origin,
    streamId: options.streamId,
    initialize: async () =>
      (await openRecordingHistory({ ...options, serverOrigin: origin }))
        .metadata,
  });
  const write =
    options.write ??
    ((text: string) =>
      new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) =>
          error ? reject(error) : resolve(),
        ),
      ));
  let state = initialState();
  let bytes = 0;
  const maximum = 64 * 1024 * 1024;
  try {
    // Reconstruct and display the local prefix even before a reconnect succeeds.
    for await (const event of cache.events()) {
      options.signal.throwIfAborted();
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > maximum)
        throw new Error(
          "Terminal reference watch exceeds its 64 MiB event budget; paged state is not yet available",
        );
      const previous = state;
      state = apply(state, event);
      const text = renderTerminalEvent(
        event,
        state,
        origin,
        options.streamId,
        previous,
      );
      if (text) await write(text);
    }
    const client = new SubscriberClient({
      serverOrigin: origin,
      cursor: cache.cursor,
      ...(options.credential ? { credential: options.credential } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      commit: async (events, cursor) => {
        const added = events.reduce(
          (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
          0,
        );
        if (bytes + added > maximum)
          throw new Error(
            "Terminal reference watch exceeds its 64 MiB event budget; paged state is not yet available",
          );
        let next = state;
        const output: string[] = [];
        for (const event of events) {
          const previous = next;
          next = apply(next, event);
          output.push(
            renderTerminalEvent(
              event,
              next,
              origin,
              options.streamId,
              previous,
            ),
          );
        }
        await cache.commit(events, cursor);
        state = next;
        bytes += added;
        for (const text of output) if (text) await write(text);
      },
    });
    await client.run(options.signal);
  } finally {
    await cache.close();
  }
}
