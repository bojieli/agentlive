/** Exercise the actual browser transport/model against a native probe's recording. */
import { BrowserSession } from "../apps/web/dist/session.js";
import { openRecordingHistory } from "../packages/client/dist/index.js";
import { apply, initialState } from "../packages/playback/dist/index.js";
const serialize = (value) =>
  JSON.stringify(value, (_, item) => (item instanceof Map ? [...item] : item));
export async function verifyBrowserSession(
  serverOrigin,
  streamId,
  credential,
  parentSignal,
) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]);
  const history = await openRecordingHistory({
    serverOrigin,
    streamId,
    credential,
    signal,
  });
  const events = [];
  for await (const event of history.events) events.push(event);
  const viewer = await BrowserSession.open(
    streamId,
    credential,
    signal,
    () => {},
    serverOrigin,
  );
  try {
    while (viewer.received < history.metadata.serverSeq) {
      signal.throwIfAborted();
      if (viewer.error)
        throw new Error("Browser model failed to receive native history");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (viewer.received !== history.metadata.serverSeq)
      throw new Error("Probe history changed during browser verification");
    const selected = viewer.duration / 2;
    viewer.seek(selected);
    viewer.setActive(false);
    while (viewer.status !== "suspended") {
      signal.throwIfAborted();
      if (viewer.error)
        throw new Error("Browser model failed during suspension");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    viewer.setActive(true);
    viewer.reconnect();
    while (viewer.status !== "live") {
      signal.throwIfAborted();
      if (viewer.error)
        throw new Error("Browser model failed during foreground revalidation");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (
      viewer.time !== selected ||
      viewer.follow ||
      viewer.received !== history.metadata.serverSeq
    )
      throw new Error(
        "Foreground recovery changed paused presentation or duplicated receipt",
      );
    for (const time of [
      viewer.duration,
      0,
      viewer.duration / 2,
      viewer.duration,
    ]) {
      let expected = initialState();
      for (const event of events)
        if (event.timelineMs <= time) expected = apply(expected, event);
      viewer.seek(time);
      if (serialize(expected) !== serialize(viewer.state))
        throw new Error("Browser native replay differs from retained history");
    }
    return {
      received: viewer.received,
      messages: viewer.state.messages.size,
      tools: viewer.state.tools.size,
      artifacts: viewer.state.artifacts.size,
      seekVerified: true,
      foregroundRevalidated: true,
    };
  } finally {
    await viewer.close();
  }
}
