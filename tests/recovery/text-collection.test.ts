import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TextStore,
  ContentPins,
  type ContentCollectionTrace,
} from "../../packages/storage/src/index.js";
import {
  PagedReducer,
  initialPagedState,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
it("collects intermediate reducer content and reopens retained checkpoints after reclaiming capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-collection-"));
  let store = await TextStore.open(directory);
  try {
    const reducer = new PagedReducer(store),
      binding = { streamId: "stream", revision: "revision" };
    let state = initialPagedState();
    for (let i = 0; i < 20; i++) {
      const event: StoredEvent = {
        protocolVersion: 1,
        serverSeq: i + 1,
        timelineMs: i,
        receivedAt: "2026-09-10T00:00:00Z",
        origin: { type: "server", operationId: `event-${i}` },
        content:
          i === 0
            ? {
                kind: "message.started",
                payload: { messageId: "m", role: "assistant" },
              }
            : {
                kind: "message.text.append",
                payload: { messageId: "m", text: "text" },
              },
      };
      state = await reducer.apply(state, event);
    }
    const checkpoint = await reducer.checkpoint(state, binding),
      before = store.usage.storedBytes;
    const result = await store.collect(async (scope, signal) => {
      const readonly = new PagedReducer({
        read: scope.read,
        put: async () => {
          throw new Error("write");
        },
        append: async () => {
          throw new Error("write");
        },
      });
      await readonly.trace(checkpoint, binding, scope.retain, signal);
    });
    expect(result.removed).toBeGreaterThan(0);
    expect(result.reclaimedBytes).toBeGreaterThan(before / 2);
    const remaining = store.usage.storedBytes;
    await store.close();
    store = await TextStore.open(directory);
    expect(store.usage.storedBytes).toBe(remaining);
    const reopened = new PagedReducer(store);
    expect(
      (
        await reopened.materialize(await reopened.open(checkpoint, binding))
      ).messages.get("m")!.text,
    ).toBe("text".repeat(19));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("excludes queued writes, rejects escaped trace scopes and never sweeps failed marks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-collection-race-"));
  const store = await TextStore.open(directory);
  try {
    const kept = await store.put("keep"),
      orphan = await store.put("orphan");
    let release!: () => void,
      entered!: () => void,
      scope!: ContentCollectionTrace;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collecting = store.collect(async (active) => {
      scope = active;
      entered();
      await waiting;
      await active.retain(kept);
    });
    await ready;
    let written = false;
    const writing = store.put("later").then((ref) => {
      written = true;
      return ref;
    });
    await Promise.resolve();
    expect(written).toBe(false);
    release();
    await collecting;
    const later = await writing;
    expect(await store.read(later, 0, later.units)).toBe("later");
    await expect(scope.retain(orphan)).rejects.toThrow("scope");
    const before = store.usage.storedBytes;
    await expect(
      store.collect(async (scope) => {
        await scope.retain(kept);
        throw new Error("trace failed");
      }),
    ).rejects.toThrow("trace failed");
    expect(store.usage.storedBytes).toBe(before);
    // Even if the callback catches a failed dependency read, the whole mark phase fails.
    await expect(
      store.collect(async (scope) => {
        await scope.retain(orphan).catch(() => {});
      }),
    ).rejects.toThrow();
    expect(store.usage.storedBytes).toBe(before);
    const abort = new AbortController();
    await expect(
      store.collect(async (scope) => {
        await scope.retain(kept);
        abort.abort(new Error("cancel collection"));
      }, abort.signal),
    ).rejects.toThrow("cancel collection");
    expect(store.usage.storedBytes).toBe(before);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["mark", "sweep"])(
  "recovers retained content after SIGKILL during %s",
  async (phase) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { createInterface } = await import("node:readline");
    const { readdir, stat } = await import("node:fs/promises");
    const directory = await mkdtemp(
      join(tmpdir(), "agentlive-collection-kill-"),
    );
    let store = await TextStore.open(directory);
    const kept = await store.put("retained text".repeat(2000));
    for (let index = 0; index < 12; index++)
      await store.put(`unreferenced-${index}`);
    const before = store.usage.storedBytes;
    await store.close();
    const moduleUrl = new URL(
      "../../packages/storage/dist/index.js",
      import.meta.url,
    ).href;
    const script = `
    import { TextStore, BlobStore } from ${JSON.stringify(moduleUrl)};
    const store = await TextStore.open(process.argv[1]);
    const kept = JSON.parse(process.argv[2]);
    setInterval(() => {}, 1000);
    const pause = async () => { console.log("crash-boundary"); await new Promise(() => {}); };
    if (process.argv[3] === "sweep") {
      const original = BlobStore.prototype.collectMarked;
      BlobStore.prototype.collectMarked = function(marked, cutoff, signal) {
        const before = this.usage.storedBytes;
        return original.call(this, async (hash) => {
          if (this.usage.storedBytes < before) await pause();
          return marked(hash);
        }, cutoff, signal);
      };
    }
    await store.collect(async (scope) => {
      await scope.retain(kept);
      if (process.argv[3] === "mark") await pause();
    });
  `;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        directory,
        JSON.stringify(kept),
        phase,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout! });
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        exited.then(() => {
          throw new Error(`Child exited early: ${stderr}`);
        }),
      ]);
      expect(line).toBe("crash-boundary");
      expect((await readdir(join(directory, "collection"))).length).toBe(1);
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      store = await TextStore.open(directory);
      expect(await store.read(kept, 0, kept.units)).toBe(
        "retained text".repeat(2000),
      );
      await expect(stat(join(directory, "collection"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      let diskBytes = 0;
      for (const name of await readdir(join(directory, "pages")))
        if (name !== ".uploads")
          diskBytes += (await stat(join(directory, "pages", name))).size;
      expect(store.usage.storedBytes).toBe(diskBytes);
      if (phase === "mark") expect(diskBytes).toBe(before);
      else expect(diskBytes).toBeLessThan(before);
      const result = await store.collect(async (scope) => {
        await scope.retain(kept);
      });
      expect(result.removed).toBeGreaterThan(0);
      expect(await store.read(kept, 0, kept.units)).toBe(
        "retained text".repeat(2000),
      );
    } finally {
      child.kill("SIGKILL");
      await exited;
      lines.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it("traces repeated retained manifests once per attempt without confusing raw blob marks", async () => {
  const { vi } = await import("vitest");
  const { TextContent } = await import("../../packages/protocol/dist/index.js");
  const directory = await mkdtemp(join(tmpdir(), "agentlive-trace-once-"));
  const store = await TextStore.open(directory);
  const traced = vi.spyOn(TextContent.prototype, "trace");
  try {
    const ref = await store.put("shared content".repeat(2000));
    await store.collect(async (scope) => {
      await scope.retainBlob(ref);
      for (let i = 0; i < 20; i++) await scope.retain(ref);
    });
    expect(traced).toHaveBeenCalledTimes(1);
    expect(await store.read(ref, 0, ref.units)).toBe(
      "shared content".repeat(2000),
    );
    await store.collect(async (scope) => {
      await scope.retain(ref);
    });
    expect(traced).toHaveBeenCalledTimes(2);
  } finally {
    traced.mockRestore();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds metadata read caching and respects cancellation even for a cached range", async () => {
  const { vi } = await import("vitest");
  const { TextContent } = await import("../../packages/protocol/dist/index.js");
  const directory = await mkdtemp(join(tmpdir(), "agentlive-trace-cache-"));
  const store = await TextStore.open(directory);
  const reads = vi.spyOn(TextContent.prototype, "read");
  try {
    const ref = await store.put("x".repeat(200));
    await store.collect(async (scope) => {
      await scope.retain(ref);
      for (let i = 0; i < 20; i++)
        expect(await scope.read(ref, 0, 1)).toBe("x");
      expect(reads).toHaveBeenCalledTimes(1);
      for (let i = 1; i <= 128; i++) await scope.read(ref, i, 1);
      await scope.read(ref, 0, 1);
      expect(reads).toHaveBeenCalledTimes(130);
    });
    const before = store.usage.storedBytes;
    await expect(
      store.collect(async (scope) => {
        await scope.read(ref, 0, 1);
        const abort = new AbortController();
        abort.abort(new Error("cancel cached read"));
        await scope.read(ref, 0, 1, abort.signal);
      }),
    ).rejects.toThrow("cancel cached read");
    expect(store.usage.storedBytes).toBe(before);
  } finally {
    reads.mockRestore();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains whole pinned text and only the exact pinned blob through collection and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-typed-pins-"));
  let store = await TextStore.open(directory);
  try {
    const complete = await store.put("whole text"),
      partial = await store.put("only a page"),
      orphan = await store.put("unretained");
    const page = (await store.trace(partial)).find(
      (ref) => ref.hash !== partial.hash,
    )!;
    expect(page).toBeDefined();
    const bytes = await store.readBlob(page);
    const pins = new ContentPins();
    pins.pin([complete]);
    pins.pin([page], "blob");
    await pins.withBarrier(async (roots) => {
      await store.collect(async (scope) => {
        for (const { kind, ref } of roots)
          await (kind === "text" ? scope.retain(ref) : scope.retainBlob(ref));
      });
    });
    await store.close();
    store = await TextStore.open(directory);
    expect(await store.read(complete, 0, complete.units)).toBe("whole text");
    expect(await store.readBlob(page)).toEqual(bytes);
    await expect(store.readBlob(partial)).rejects.toMatchObject({
      code: "precondition_failed",
    });
    await expect(store.readBlob(orphan)).rejects.toMatchObject({
      code: "precondition_failed",
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
