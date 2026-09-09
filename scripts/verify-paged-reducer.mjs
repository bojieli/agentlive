import { activityRows } from "../apps/web/dist/activity.js";
import { readTextPage } from "../apps/web/dist/text-source.js";
import { textPage } from "../apps/web/dist/text-page.js";
import { BrowserPagedState } from "../apps/web/dist/paged-state.js";
import { createRequire } from "node:module";
import { BrowserContentStore } from "../apps/web/dist/content-store.js";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
/** Compare actual paged event application with a native recording's reference replay. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TextStore } from "../packages/storage/dist/index.js";
import {
  PagedReducer,
  initialPagedState,
} from "../packages/playback/dist/index.js";
export async function verifyPagedReducer(events, expected, signal) {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-paged-native-"));
  let store, browser, browserReadStore;
  try {
    store = await TextStore.open(directory);
    let reducer = new PagedReducer(store),
      state = initialPagedState(),
      reopened = false;
    const binding = {
      streamId: "native-paged-probe",
      revision: "native-paged-revision",
    };
    const factory = new IDBFactory(),
      browserBinding = {
        ...binding,
        serverOrigin: "http://native-probe.invalid",
      };
    browser = await BrowserPagedState.open(factory, browserBinding, signal);
    for (const [index, event] of events.entries()) {
      state = await reducer.apply(state, event, signal);
      await browser.apply([event], signal);
      if (index === Math.floor(events.length / 2)) {
        const checkpoint = await reducer.checkpoint(state, binding, signal);
        const browserCheckpoint = browser.checkpoint.ref;
        if (!isDeepStrictEqual(browserCheckpoint, checkpoint))
          throw new Error("Browser and filesystem content references differ");
        await browser.close();
        browser = await BrowserPagedState.open(factory, browserBinding, signal);
        if (browser.state.appliedSeq !== state.appliedSeq)
          throw new Error("Browser checkpoint pointer did not recover");
        await store.close();
        store = await TextStore.open(directory);
        reducer = new PagedReducer(store);
        state = await reducer.open(checkpoint, binding, signal);
        reopened = true;
      }
    }
    if (
      !isDeepStrictEqual(
        await reducer.materialize(state, 16 * 1024 * 1024, signal),
        expected,
      )
    )
      throw new Error("Native paged reducer differs from reference replay");
    browserReadStore = await BrowserContentStore.open(
      factory,
      browserBinding,
      signal,
    );
    const browserReducer = new PagedReducer(browserReadStore);
    if (
      !isDeepStrictEqual(
        await browserReducer.materialize(
          browser.state,
          16 * 1024 * 1024,
          signal,
        ),
        expected,
      )
    )
      throw new Error("Browser paged reducer differs from reference replay");
    let pagedTextFields = 0;
    for (const [name, fields] of [
      ["messages", ["text"]],
      ["tools", ["input", "output"]],
      ["changes", ["patch"]],
    ]) {
      for (const [id, original] of expected[name]) {
        const item = await browser.get(name, id, signal);
        for (const field of fields) {
          const source = browser.textSource(item[field]);
          for (const page of [0, Number.MAX_SAFE_INTEGER])
            if (
              !isDeepStrictEqual(
                await readTextPage(source, page, signal),
                textPage(original[field], page),
              )
            )
              throw new Error(
                "Stored text page differs from reference rendering",
              );
          pagedTextFields++;
        }
      }
    }
    const view = browser.view();
    let pagedActivityCards = 0;
    for (const row of activityRows(expected, () => 0)) {
      const card = await view.load(row, signal);
      if (!card) throw new Error("Visible paged activity is missing");
      if (row.kind === "gaps") {
        if (!isDeepStrictEqual(card.gap, expected.gaps[Number(row.id)]))
          throw new Error("Paged capture note differs");
      } else {
        const original = expected[row.kind].get(row.id),
          actual = { ...card.state[row.kind].get(row.id) };
        for (const field of row.kind === "messages"
          ? ["text"]
          : row.kind === "tools"
            ? ["input", "output"]
            : row.kind === "changes"
              ? ["patch"]
              : []) {
          if (
            actual[field] !== "" ||
            card.texts[field].units !== original[field].length
          )
            throw new Error(
              "Paged activity loaded text eagerly or lost its reference",
            );
          actual[field] = original[field];
        }
        const wanted =
          row.kind === "artifacts"
            ? {
                ...original,
                versions: new Map([...original.versions].slice(0, 32)),
              }
            : original;
        if (!isDeepStrictEqual(actual, wanted))
          throw new Error(
            "Paged activity metadata differs from reference state",
          );
      }
      pagedActivityCards++;
    }
    return {
      events: events.length,
      reopened,
      equivalent: true,
      browserContentReopened: true,
      browserCheckpointRecovered: true,
      identicalContentReferences: true,
      pagedTextFields,
      pagedActivityCards,
      storedBytes: store.usage.storedBytes,
    };
  } finally {
    try {
      try {
        try {
          await browser?.close();
        } finally {
          await browserReadStore?.close();
        }
      } finally {
        await store?.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
