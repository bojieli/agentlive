import {
  PagedSnapshotReader,
  activityMentions,
} from "../packages/playback/dist/index.js";
import { activityRows } from "../apps/web/dist/activity.js";
/** Exercise production snapshot client and server without retaining native text. */
import { createRequire } from "node:module";
import { BrowserSnapshotCache } from "../apps/web/dist/snapshot-cache.js";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
import { isDeepStrictEqual } from "node:util";
import { RecordingSnapshotClient } from "../packages/client/dist/index.js";
export async function verifyServerSnapshot(
  serverOrigin,
  streamId,
  credential,
  revision,
  state,
  signal,
  events,
) {
  const order = new Map();
  for (const event of events)
    for (const { key } of activityMentions(event))
      if (!order.has(key)) order.set(key, event.serverSeq);
  const expectedKeys = activityRows(
    state,
    (key) => order.get(key) ?? Number.MAX_SAFE_INTEGER,
  ).map((row) => row.key);
  const verifyRows = async (reader) => {
    if (!(reader instanceof PagedSnapshotReader) || !reader.activityState)
      throw new Error("Server snapshot omitted paired activity order");
    const keys = [];
    for (
      let offset = 0;
      offset < (reader.activityState.visible?.count ?? 0);
      offset += 32
    )
      keys.push(
        ...(await reader.activityRows(offset, 32, signal)).map(
          (row) => row.key,
        ),
      );
    if (!isDeepStrictEqual(keys, expectedKeys))
      throw new Error("HTTP snapshot activity order differs from reference");
    for (const [position, key] of keys.entries())
      if ((await reader.activityPosition(key, signal)) !== position)
        throw new Error("HTTP snapshot activity position differs");
  };
  let reads = 0;
  const factory = new IDBFactory();
  let cache = await BrowserSnapshotCache.open(factory, signal);
  const options = {
    serverOrigin,
    streamId,
    credential,
    revision,
    fetch: (url, init) => {
      if (new URL(String(url)).pathname.includes("/snapshot-content/")) reads++;
      return fetch(url, init);
    },
  };
  const client = new RecordingSnapshotClient({ ...options, cache });
  try {
    const published = await client.publish(state.appliedSeq, signal);
    const selected = await client.select(state.appliedSeq, signal);
    if (
      !selected ||
      !isDeepStrictEqual(published.descriptor, selected.descriptor)
    )
      throw new Error("Native snapshot selection differs from publication");
    if (
      !isDeepStrictEqual(
        await selected.reader.materialize(16 * 1024 * 1024, signal),
        state,
      )
    )
      throw new Error("Native HTTP snapshot differs from reference state");
    await verifyRows(selected.reader);
    client.close();
    cache.close();
    cache = await BrowserSnapshotCache.open(factory, signal);
    const restored = new RecordingSnapshotClient({ ...options, cache });
    const before = reads;
    try {
      const reopened = await restored.select(state.appliedSeq, signal);
      if (
        !reopened ||
        !isDeepStrictEqual(
          await reopened.reader.materialize(16 * 1024 * 1024, signal),
          state,
        )
      )
        throw new Error(
          "Reopened browser snapshot cache differs from reference state",
        );
      await verifyRows(reopened.reader);
    } finally {
      restored.close();
    }
    return {
      serverSeq: selected.reader.manifest.serverSeq,
      contentReads: reads,
      verified: true,
      sharedClient: true,
      indexedActivityRows: expectedKeys.length,
      browserRangeCacheReopened: true,
      reopenedContentReads: reads - before,
    };
  } finally {
    client.close();
    cache.close();
  }
}
