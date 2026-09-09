/** Exercise bounded, reopened content reads using filtered native recording text. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ContentIndex,
  OrderedContentMap,
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
    for (const text of fields) {
      const split = Math.floor(text.length / 2);
      const prefix = await store.put(text.slice(0, split), signal);
      const ref = await store.append(prefix, text.slice(split), signal);
      if (!isDeepStrictEqual(ref, await store.put(text, signal)))
        throw new Error(
          "Incremental native text reference differs from complete write",
        );
      references.push(ref);
    }
    const binding = {
      streamId: "native-probe",
      revision: "native-probe-revision",
    };
    const snapshotRef = await createSnapshot(state, binding, store, signal);
    const contentIndex = new ContentIndex(store);
    const fieldKey = (index) => `field-${String(index).padStart(10, "0")}`;
    const indexRoot = await contentIndex.build(
      references.map((ref, index) => [fieldKey(index), ref]),
      signal,
    );
    let orderedRoot = null;
    const ordered = new OrderedContentMap(store);
    for (const [index, ref] of references.entries())
      orderedRoot = await ordered.set(orderedRoot, index, ref, signal);
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
    const reopenedIndex = new ContentIndex(store);
    const reopenedMap = new OrderedContentMap(store);
    for (let offset = 0; offset < references.length; offset += 32) {
      const actual = await reopenedMap.entries(orderedRoot, offset, 32, signal);
      const expected = references
        .slice(offset, offset + 32)
        .map((ref, index) => [offset + index, ref]);
      if (!isDeepStrictEqual(actual, expected))
        throw new Error("Native content map order differs after reopening");
    }
    let units = 0;
    for (const [index, ref] of references.entries()) {
      if (
        !isDeepStrictEqual(
          await reopenedIndex.get(indexRoot, fieldKey(index), signal),
          ref,
        )
      )
        throw new Error("Native content index differs after reopening");
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
      indexedFields: references.length,
      appendedFields: references.length,
      indexReopened: true,
      orderedFields: references.length,
      mapReopened: true,
    };
  } finally {
    try {
      await store?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
