/** Exercise bounded, reopened content reads using filtered native recording text. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSnapshot,
  SnapshotReader,
} from "../packages/playback/dist/index.js";
import { TextStore } from "../packages/storage/dist/index.js";
export async function verifyContentStore(state, signal) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-content-probe-"));
  let store;
  try {
    store = await TextStore.open(root);
    const references = [];
    const fields = [
      ...[...state.messages.values()].map((message) => message.text),
      ...[...state.tools.values()].flatMap((tool) => [tool.input, tool.output]),
      ...[...state.changes.values()].map((change) => change.patch),
    ];
    for (const text of fields) references.push(await store.put(text, signal));
    const binding = {
      streamId: "native-probe",
      revision: "native-probe-revision",
    };
    const snapshotRef = await createSnapshot(state, binding, store, signal);
    const storedBytes = store.usage.storedBytes;
    await store.close();
    store = await TextStore.open(root);
    const snapshot = await SnapshotReader.open(
      snapshotRef,
      binding,
      store,
      signal,
    );
    const restored = await snapshot.materialize(16 * 1024 * 1024, signal);
    if (!isDeepStrictEqual(restored, state))
      throw new Error("Native snapshot differs after reopening");
    let units = 0;
    for (const [index, ref] of references.entries()) {
      for (let offset = 0; offset < ref.units; offset += 30113) {
        const count = Math.min(30113, ref.units - offset);
        if (
          (await store.read(ref, offset, count, signal)) !==
          fields[index].slice(offset, offset + count)
        )
          throw new Error("Native paged content differs after reopening");
      }
      if (!ref.units && (await store.read(ref, 0, 0, signal)) !== "")
        throw new Error("Empty native content differs after reopening");
      units += ref.units;
    }
    return {
      fields: fields.length,
      units,
      storedBytes,
      reopened: true,
      snapshotVerified: true,
    };
  } finally {
    try {
      await store?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
