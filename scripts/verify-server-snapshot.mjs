/** Exercise production snapshot publication and HTTP reads without retaining native text. */
import { isDeepStrictEqual } from "node:util";
import { SnapshotReader } from "../packages/playback/dist/index.js";
export async function verifyServerSnapshot(
  serverOrigin,
  streamId,
  credential,
  revision,
  state,
  signal,
) {
  const base = `${serverOrigin}/api/v1/streams/${encodeURIComponent(streamId)}`;
  const headers = {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
  };
  async function request(path, options = {}) {
    const response = await fetch(base + path, {
      ...options,
      headers,
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        `Native snapshot HTTP verification failed (${response.status})`,
      );
    return response.json();
  }
  const published = await request("/snapshots", {
    method: "POST",
    body: JSON.stringify({ revision, throughServerSeq: state.appliedSeq }),
  });
  const selected = await request(
    `/snapshots?${new URLSearchParams({ revision, throughServerSeq: String(state.appliedSeq) })}`,
  );
  if (
    !isDeepStrictEqual(published, selected) ||
    selected.streamId !== streamId ||
    selected.revision !== revision
  )
    throw new Error("Native snapshot selection differs from publication");
  let reads = 0;
  const reader = await SnapshotReader.open(
    selected.snapshot.ref,
    { streamId, revision },
    {
      put: async () => {
        throw new Error("Read-only snapshot verifier");
      },
      read: async (ref, offset, length) => {
        reads++;
        const query = new URLSearchParams({
          revision,
          byteSize: String(ref.byteSize),
          units: String(ref.units),
          offset: String(offset),
          length: String(length),
        });
        return (await request(`/snapshot-content/${ref.hash}?${query}`)).text;
      },
    },
    signal,
  );
  if (
    !isDeepStrictEqual(
      await reader.materialize(16 * 1024 * 1024, signal),
      state,
    )
  )
    throw new Error("Native HTTP snapshot differs from reference state");
  return {
    serverSeq: reader.manifest.serverSeq,
    contentReads: reads,
    verified: true,
  };
}
