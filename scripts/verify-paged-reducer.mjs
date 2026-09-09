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
  let store, browser;
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
    browser = await BrowserContentStore.open(factory, browserBinding, signal);
    let browserReducer = new PagedReducer(browser),
      browserState = initialPagedState();
    for (const [index, event] of events.entries()) {
      state = await reducer.apply(state, event, signal);
      browserState = await browserReducer.apply(browserState, event, signal);
      if (index === Math.floor(events.length / 2)) {
        const checkpoint = await reducer.checkpoint(state, binding, signal);
        const browserCheckpoint = await browserReducer.checkpoint(
          browserState,
          binding,
          signal,
        );
        if (!isDeepStrictEqual(browserCheckpoint, checkpoint))
          throw new Error("Browser and filesystem content references differ");
        await browser.close();
        browser = await BrowserContentStore.open(
          factory,
          browserBinding,
          signal,
        );
        browserReducer = new PagedReducer(browser);
        browserState = await browserReducer.open(
          browserCheckpoint,
          binding,
          signal,
        );
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
    if (
      !isDeepStrictEqual(
        await browserReducer.materialize(
          browserState,
          16 * 1024 * 1024,
          signal,
        ),
        expected,
      )
    )
      throw new Error("Browser paged reducer differs from reference replay");
    return {
      events: events.length,
      reopened,
      equivalent: true,
      browserContentReopened: true,
      identicalContentReferences: true,
      storedBytes: store.usage.storedBytes,
    };
  } finally {
    try {
      try {
        await browser?.close();
      } finally {
        await store?.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
