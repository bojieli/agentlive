import { verifyServerSnapshot } from "./verify-server-snapshot.mjs";
/** Exercise the actual browser transport/model against a native probe's recording. */
import { verifyContentStore } from "./verify-content-store.mjs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
import { createHash } from "node:crypto";
import { searchActivity } from "../apps/web/dist/activity-search.js";
import { ActivityCard, activityRows } from "../apps/web/dist/activity.js";
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
  const platform = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
  const viewer = await BrowserSession.open(
    streamId,
    credential,
    signal,
    () => {},
    serverOrigin,
    { platform },
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
    const rows = activityRows(viewer.state, (key) => viewer.order(key));
    const searchMessage = [...viewer.state.messages.values()].find(
      (message) => message.visible !== false && message.text.length > 8,
    );
    let activitySearchVerified = false;
    if (searchMessage) {
      const query = searchMessage.text.slice(0, 32);
      let start = 0;
      while (true) {
        const page = await searchActivity(
          viewer.state,
          rows,
          query,
          signal,
          start,
        );
        if (
          page.matches.some(
            (match) => match.key === `messages/${searchMessage.id}`,
          )
        ) {
          activitySearchVerified = true;
          break;
        }
        if (page.nextIndex === null)
          throw new Error("Native message missing from activity search");
        start = page.nextIndex;
      }
    }
    const rendered = createHash("sha256");
    for (const row of rows)
      rendered.update(
        renderToStaticMarkup(
          createElement(ActivityCard, {
            row,
            state: viewer.state,
            onAttachment: () => {},
          }),
        ),
      );
    const contentStore = await verifyContentStore(viewer.state, signal);
    const serverSnapshot = await verifyServerSnapshot(
      serverOrigin,
      streamId,
      credential,
      history.metadata.revision,
      viewer.state,
      signal,
    );
    const counts = {
      contentStore,
      serverSnapshot,
      renderedActivityItems: rows.length,
      activitySearchVerified,
      activityMarkupHash: rendered.digest("hex"),
      messages: viewer.state.messages.size,
      tools: viewer.state.tools.size,
      artifacts: viewer.state.artifacts.size,
    };
    viewer.seek(viewer.duration / 2);
    viewer.setSpeed(2);
    viewer.setPlaying(false);
    await viewer.close();
    const restored = await BrowserSession.open(
      streamId,
      credential,
      signal,
      () => {},
      serverOrigin,
      { platform },
    );
    try {
      if (
        restored.restoredEvents !== viewer.received ||
        serialize(restored.state) !== serialize(viewer.state) ||
        restored.time !== viewer.time ||
        restored.speed !== 2 ||
        restored.playing ||
        restored.follow
      )
        throw new Error("Persistent browser model differs after reload");
    } finally {
      await restored.close();
    }
    return {
      received: viewer.received,
      ...counts,
      seekVerified: true,
      foregroundRevalidated: true,
      persistedReloadVerified: true,
      pausedPlaybackRestored: true,
    };
  } finally {
    await viewer.close();
  }
}
