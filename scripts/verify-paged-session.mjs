import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { BrowserPagedSession } from "../apps/web/dist/paged-session.js";
import { activityRows } from "../apps/web/dist/activity.js";
import { readTextPage } from "../apps/web/dist/text-source.js";
import { textPage } from "../apps/web/dist/text-page.js";
import {
  apply,
  initialState,
  activityMentions,
} from "../packages/playback/dist/index.js";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
export async function verifyPagedSession(
  origin,
  streamId,
  credential,
  events,
  signal,
) {
  const platform = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
  const open = () =>
    BrowserPagedSession.open(streamId, credential, signal, () => {}, origin, {
      platform,
    });
  let viewer = await open();
  let checkedTextFields = 0;
  try {
    if (!(viewer instanceof BrowserPagedSession))
      throw new Error("Production paged session was not selected");
    while (
      viewer.received < events.length ||
      viewer.view.sequence < events.length
    ) {
      signal.throwIfAborted();
      if (viewer.error) throw new Error("Production paged receipt failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const verify = async () => {
      let expected = initialState();
      const order = new Map();
      for (const event of events) {
        if (event.serverSeq > viewer.view.sequence) break;
        expected = apply(expected, event);
        for (const { key } of activityMentions(event))
          if (!order.has(key)) order.set(key, event.serverSeq);
      }
      const expectedRows = activityRows(
        expected,
        (key) => order.get(key) ?? Number.MAX_SAFE_INTEGER,
      );
      const keys = [];
      for (let offset = 0; offset < viewer.view.rowCount; offset += 32) {
        for (const row of await viewer.view.rows(offset, 32, signal)) {
          keys.push(row.key);
          const card = await viewer.view.load(row, signal);
          if (!card) throw new Error("Production paged row has no card");
          const object =
            row.kind === "gaps" ? undefined : expected[row.kind].get(row.id);
          for (const [field, source] of Object.entries(card.texts)) {
            const text = object?.[field];
            if (typeof text !== "string" || source.units !== text.length)
              throw new Error("Production paged text identity differs");
            for (const page of new Set([
              0,
              Math.max(0, Math.ceil(text.length / 16384) - 1),
            ]))
              if (
                !isDeepStrictEqual(
                  await readTextPage(source, page, signal),
                  textPage(text, page),
                )
              )
                throw new Error("Production paged text range differs");
            checkedTextFields++;
          }
        }
      }
      if (
        !isDeepStrictEqual(
          keys,
          expectedRows.map((row) => row.key),
        )
      )
        throw new Error("Production paged rows differ from reference");
    };
    await verify();
    const time = viewer.duration / 2;
    await viewer.seek(time);
    if (viewer.error) throw new Error("Production paged seek failed");
    await verify();
    const selected = viewer.view.sequence;
    viewer.setSpeed(2);
    await viewer.close();
    viewer = await open();
    if (
      viewer.restoredEvents !== events.length ||
      viewer.view.sequence !== selected ||
      viewer.follow ||
      viewer.time !== time ||
      viewer.speed !== 2
    )
      throw new Error("Production paged presentation did not restore");
    await verify();
    await viewer.seek(viewer.duration, true);
    await verify();
    return {
      received: viewer.received,
      seekVerified: true,
      presentationRestored: true,
      checkedTextFields,
      pagedRows: viewer.view.rowCount,
    };
  } finally {
    await viewer.close();
  }
}
