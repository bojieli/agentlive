/** Exercise production snapshot client and server without retaining native text. */
import { isDeepStrictEqual } from "node:util";
import { RecordingSnapshotClient } from "../packages/client/dist/index.js";
export async function verifyServerSnapshot(
  serverOrigin,
  streamId,
  credential,
  revision,
  state,
  signal,
) {
  let reads = 0;
  const client = new RecordingSnapshotClient({
    serverOrigin,
    streamId,
    credential,
    revision,
    fetch: (url, init) => {
      if (new URL(String(url)).pathname.includes("/snapshot-content/")) reads++;
      return fetch(url, init);
    },
  });
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
    return {
      serverSeq: selected.reader.manifest.serverSeq,
      contentReads: reads,
      verified: true,
      sharedClient: true,
    };
  } finally {
    client.close();
  }
}
