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

it("appends by reusing completed pages and matches a complete write after reopening", async () => {
  const root = await directory();
  let store = await TextStore.open(root);
  try {
    const prefix = "a".repeat(CONTENT_PAGE_UNITS * 80) + "tail\ud83e";
    const suffix = "\udd8a" + "b".repeat(20000) + "\ud800";
    const base = await store.put(prefix);
    const before = JSON.parse(
      await readFile(join(root, "pages", base.hash), "utf8"),
    );
    const opened: string[] = [];
    const original = BlobStore.prototype.openFile;
    const spy = vi
      .spyOn(BlobStore.prototype, "openFile")
      .mockImplementation(function (hash) {
        opened.push(hash);
        return original.call(this, hash);
      });
    let appended;
    try {
      appended = await store.append(
        base,
        (async function* () {
          yield "";
          for (let i = 0; i < suffix.length; i += 7)
            yield suffix.slice(i, i + 7);
        })(),
      );
      expect(opened).not.toContain(before.pages[0].hash);
      expect(
        opened.filter((hash) => hash === before.pages.at(-1).hash),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    const after = JSON.parse(
      await readFile(join(root, "pages", appended.hash), "utf8"),
    );
    expect(after.pages.slice(0, 80)).toEqual(before.pages.slice(0, 80));
    expect(await store.put(prefix + suffix)).toEqual(appended);
    expect(await store.read(base, base.units - 5, 5)).toBe("tail\ud83e");
    await store.close();
    store = await TextStore.open(root);
    expect(await store.read(appended, prefix.length - 1, 2)).toBe("🦊");
    expect(await store.read(appended, appended.units - 1, 1)).toBe("\ud800");
    const usage = store.usage.storedBytes;
    expect(await store.append(base, suffix)).toEqual(appended);
    expect(store.usage.storedBytes).toBe(usage);
  } finally {
    await store.close();
  }
});
it("preserves full-page surrogate boundaries and makes empty appends a verified no-op", async () => {
  const root = await directory(),
    store = await TextStore.open(root);
  try {
    const text = "a".repeat(CONTENT_PAGE_UNITS - 1) + "\ud83e";
    const base = await store.put(text);
    const appended = await store.append(base, "\udd8a");
    expect(appended).toEqual(await store.put(text + "\udd8a"));
    expect(await store.read(appended, CONTENT_PAGE_UNITS - 1, 2)).toBe("🦊");
    const bytes = store.usage.storedBytes;
    const spy = vi.spyOn(BlobStore.prototype, "openFile");
    try {
      expect(
        await store.append(
          appended,
          (async function* () {
            yield "";
            yield "";
          })(),
        ),
      ).toEqual(appended);
      expect(spy.mock.calls.map(([hash]) => hash)).toEqual([appended.hash]);
      expect(store.usage.storedBytes).toBe(bytes);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await store.close();
  }
});
it("rejects corrupt append tails and preserves the base when storage capacity is exhausted", async () => {
  const root = await directory();
  let store = await TextStore.open(root);
  try {
    const base = await store.put("prefix"),
      capacity = store.usage.storedBytes;
    await store.close();
    store = await TextStore.open(root, capacity);
    expect(await store.append(base, "")).toEqual(base);
    await expect(store.append(base, "suffix")).rejects.toMatchObject({
      code: "retry_later",
    });
    expect(await store.read(base, 0, base.units)).toBe("prefix");
    const manifest = JSON.parse(
      await readFile(join(root, "pages", base.hash), "utf8"),
    );
    await writeFile(join(root, "pages", manifest.pages[0].hash), '"prefiX"');
    await expect(store.append(base, "suffix")).rejects.toThrow("checksum");
  } finally {
    await store.close();
  }
});
it("cancels a stalled append source while retaining the previously durable text", async () => {
  const root = await directory();
  const store = await TextStore.open(root);
  const base = await store.put("prefix");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = store
    .append(base, {
      [Symbol.asyncIterator]() {
        return {
          next() {
            entered();
            return new Promise<IteratorResult<string>>(() => {});
          },
          return() {
            return new Promise<IteratorResult<string>>(() => {});
          },
        };
      },
    })
    .catch((error) => error);
  try {
    await started;
    await store.close();
    expect(await work).toBeInstanceOf(Error);
    const reopened = await TextStore.open(root);
    try {
      expect(await reopened.read(base, 0, base.units)).toBe("prefix");
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});

it.each([false, true])(
  "recovers an append after process death with completed manifest=%s",
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
    const base = await store.put("x".repeat(20000));
    if (${complete}) {
      const result = await store.append(base, "y".repeat(20000));
      console.log(JSON.stringify({base, result}));
    } else {
      await store.append(base, (async function* () {
        yield "y".repeat(20000);
        console.log(JSON.stringify({base}));
        await new Promise(() => {});
      })());
    }
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, root],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = once(child, "exit"),
      lines = createInterface({ input: child.stdout! });
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        exited.then(() => {
          throw new Error("Append writer exited before crash boundary");
        }),
      ]);
      child.kill("SIGKILL");
      await exited;
      const record = JSON.parse(line),
        reopened = await TextStore.open(root);
      try {
        expect(await reopened.read(record.base, 0, 20000)).toBe(
          "x".repeat(20000),
        );
        const result = complete
          ? record.result
          : await reopened.append(record.base, "y".repeat(20000));
        expect(await reopened.read(result, 0, 40000)).toBe(
          "x".repeat(20000) + "y".repeat(20000),
        );
        const usage = reopened.usage.storedBytes;
        expect(await reopened.append(record.base, "y".repeat(20000))).toEqual(
          result,
        );
        expect(reopened.usage.storedBytes).toBe(usage);
      } finally {
        await reopened.close();
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      lines.close();
    }
  },
);

it.each(["put", "append"] as const)(
  "observes cancellation after the final %s manifest installation",
  async (operation) => {
    const store = await TextStore.open(await directory());
    const base = await store.put("prefix"),
      abort = new AbortController();
    const original = BlobStore.prototype.install;
    let installs = 0;
    const spy = vi
      .spyOn(BlobStore.prototype, "install")
      .mockImplementation(async function (staged) {
        const result = await original.call(this, staged);
        if (++installs === 2)
          abort.abort(new Error("cancelled after final manifest"));
        return result;
      });
    try {
      const work =
        operation === "put"
          ? store.put("prefixsuffix", abort.signal)
          : store.append(base, "suffix", abort.signal);
      await expect(work).rejects.toThrow("cancelled after final manifest");
      expect(installs).toBe(2);
      const retry = await store.append(base, "suffix");
      expect(await store.read(retry, 0, retry.units)).toBe("prefixsuffix");
      expect(await store.read(base, 0, base.units)).toBe("prefix");
    } finally {
      spy.mockRestore();
      await store.close();
    }
  },
);
