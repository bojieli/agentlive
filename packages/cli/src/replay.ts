import { openRecordingHistory } from "@agentlive/client";
import { initialState, apply, renderTerminalEvent } from "@agentlive/playback";
import { originOf } from "@agentlive/client/transport";
export async function replayRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  signal: AbortSignal;
}) {
  const origin = originOf(options.serverOrigin);
  const history = await openRecordingHistory({
    ...options,
    serverOrigin: origin,
  });
  let state = initialState(),
    bytes = 0;
  for await (const event of history.events) {
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (bytes > 64 * 1024 * 1024)
      throw new Error(
        "Terminal reference replay exceeds its 64 MiB event budget; paged state replay is not yet available",
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
    if (text)
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
  }
  return history.metadata;
}
