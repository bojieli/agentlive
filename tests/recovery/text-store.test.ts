import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlobStore,
  TextStore,
  CONTENT_PAGE_UNITS,
} from "../../packages/storage/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-text-store-"));
  roots.push(root);
  return root;
}
it("preserves exact native string units across pages, chunk boundaries, and restart", async () => {
  const root = await directory();
  let store = await TextStore.open(root);
  const text =
    "a".repeat(CONTENT_PAGE_UNITS - 1) +
    "🦊" +
    "b".repeat(50000) +
    "\ud800tail\udc00";
  let ref;
  try {
    ref = await store.put(
      (async function* () {
        for (let i = 0; i < text.length; i += 7) yield text.slice(i, i + 7);
      })(),
    );
    const usage = store.usage.storedBytes;
    expect(await store.put(text)).toEqual(ref);
    expect(store.usage.storedBytes).toBe(usage);
    await expect(TextStore.open(root)).rejects.toThrow();
  } finally {
    await store.close();
  }
  store = await TextStore.open(root);
  try {
    let actual = "";
    for (let i = 0; i < text.length; i += 10001)
      actual += await store.read(ref!, i, Math.min(10001, text.length - i));
    expect(actual).toBe(text);
    expect(await store.read(ref!, CONTENT_PAGE_UNITS - 1, 2)).toBe("🦊");
    await expect(store.read(ref!, 0, 65537)).rejects.toThrow("range");
    const empty = await store.put("");
    expect(await store.read(empty, 0, 0)).toBe("");
  } finally {
    await store.close();
  }
});
it("rejects corrupted page bytes before exposing any part of the requested range", async () => {
  const root = await directory();
  const store = await TextStore.open(root);
  try {
    const ref = await store.put("a".repeat(CONTENT_PAGE_UNITS) + "suffix");
    const manifest = JSON.parse(
      await readFile(join(root, "pages", ref.hash), "utf8"),
    );
    const page = manifest.pages[1];
    await writeFile(join(root, "pages", page.hash), '"suffiX"');
    await expect(store.read(ref, CONTENT_PAGE_UNITS - 1, 7)).rejects.toThrow(
      "checksum",
    );
    await expect(store.put("suffix")).rejects.toThrow("checksum");
  } finally {
    await store.close();
  }
});
it("cancels an uncooperative source and releases ownership without waiting for iterator return", async () => {
  const root = await directory();
  const store = await TextStore.open(root);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      entered();
      return new Promise<IteratorResult<string>>(() => {});
    },
    return() {
      return new Promise<IteratorResult<string>>(() => {});
    },
  };
  const work = store.put(source).catch((error) => error);
  await started;
  await store.close();
  expect(await work).toBeInstanceOf(Error);
  const reopened = await TextStore.open(root);
  await reopened.close();
});
it("enforces storage quota and reuses existing content at capacity", async () => {
  const root = await directory();
  let store = await TextStore.open(root);
  const ref = await store.put("saved");
  const capacity = store.usage.storedBytes;
  await store.close();
  store = await TextStore.open(root, capacity);
  try {
    expect(await store.put("saved")).toEqual(ref);
    await expect(store.put("new content")).rejects.toThrow("capacity");
    expect(await store.read(ref, 0, 5)).toBe("saved");
  } finally {
    await store.close();
  }
});

it("yields to cancellation for an endless sequence of empty input chunks", async () => {
  const store = await TextStore.open(await directory());
  const abort = new AbortController();
  try {
    const work = store.put(
      (async function* () {
        while (true) yield "";
      })(),
      abort.signal,
    );
    setTimeout(() => abort.abort(new Error("cancelled")), 0);
    await expect(work).rejects.toThrow("cancelled");
  } finally {
    await store.close();
  }
});
it("keeps ownership while an accepted install drains after close", async () => {
  const root = await directory();
  const store = await TextStore.open(root);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = BlobStore.prototype.install;
  const spy = vi
    .spyOn(BlobStore.prototype, "install")
    .mockImplementationOnce(async function (staged) {
      enter();
      await gate;
      return original.call(this, staged);
    });
  const write = store.put("accepted bytes").catch((error) => error);
  try {
    await entered;
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    await expect(TextStore.open(root)).rejects.toThrow();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(await write).toBeInstanceOf(Error);
    const recovered = await TextStore.open(root);
    try {
      const ref = await recovered.put("accepted bytes");
      expect(await recovered.read(ref, 0, ref.units)).toBe("accepted bytes");
    } finally {
      await recovered.close();
    }
  } finally {
    release();
    await write;
    await store.close();
    spy.mockRestore();
  }
});
it("bounds admitted operations behind a stalled source", async () => {
  const store = await TextStore.open(await directory());
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const first = store
    .put({
      [Symbol.asyncIterator]() {
        return {
          next() {
            enter();
            return new Promise<IteratorResult<string>>(() => {});
          },
        };
      },
    })
    .catch((error) => error);
  try {
    await entered;
    const waiting = Array.from({ length: 15 }, () =>
      store.put("queued").catch((error) => error),
    );
    await expect(store.put("excess")).rejects.toThrow("queue is full");
    await store.close();
    await Promise.all([first, ...waiting]);
  } finally {
    await store.close();
  }
});

it.each([false, true])(
  "recovers after actual process death with completed manifest=%s",
  async (complete) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { createInterface } = await import("node:readline");
    const root = await directory();
    const moduleUrl = new URL(
      "../../packages/storage/dist/index.js",
      import.meta.url,
    ).href;
    const script = `
    import { TextStore } from ${JSON.stringify(moduleUrl)};
    const store = await TextStore.open(process.argv[1]);
    setInterval(() => {}, 1000);
    if (${complete}) {
      const ref = await store.put("x".repeat(40000));
      console.log(JSON.stringify(ref));
    } else {
      await store.put((async function* () {
        yield "x".repeat(16384);
        console.log("partial");
        await new Promise(() => {});
      })());
    }
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, root],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout! });
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        exited.then(() => {
          throw new Error("Content writer exited before crash boundary");
        }),
      ]);
      child.kill("SIGKILL");
      await exited;
      const recovered = await TextStore.open(root);
      try {
        expect(recovered.usage.storedBytes).toBeGreaterThan(0);
        const ref = complete
          ? JSON.parse(line)
          : await recovered.put("x".repeat(40000));
        expect(await recovered.read(ref, 0, 40000)).toBe("x".repeat(40000));
      } finally {
        await recovered.close();
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      lines.close();
    }
  },
);
