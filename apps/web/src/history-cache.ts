import {
  canonicalJson,
  storedEventSchema,
  type StoredEvent,
} from "@agentlive/protocol";
export interface CacheBinding {
  serverOrigin: string;
  streamId: string;
  revision: string;
}
export interface CachePlatform {
  indexedDB: IDBFactory;
  keyRange: typeof IDBKeyRange;
}
export class CacheAheadError extends Error {}
export interface BrowserView {
  serverSeq: number;
  timelineMs: number;
  speed: number;
  idleCapMs?: number;
  gapAnchorMs?: number;
  mode: "follow" | "paused" | "playing";
}
interface SavedView extends BrowserView {
  through: number;
  hash: string;
}
function view(value: unknown): SavedView | undefined {
  const saved = value as SavedView;
  if (
    !saved ||
    typeof saved !== "object" ||
    ![
      "hash,mode,serverSeq,speed,through,timelineMs",
      "hash,idleCapMs,mode,serverSeq,speed,through,timelineMs",
      "gapAnchorMs,hash,mode,serverSeq,speed,through,timelineMs",
      "gapAnchorMs,hash,idleCapMs,mode,serverSeq,speed,through,timelineMs",
    ].includes(Object.keys(saved).sort().join(",")) ||
    ("idleCapMs" in saved &&
      (typeof saved.idleCapMs !== "number" ||
        !Number.isFinite(saved.idleCapMs) ||
        saved.idleCapMs < 0)) ||
    ("gapAnchorMs" in saved &&
      (typeof saved.gapAnchorMs !== "number" ||
        !Number.isFinite(saved.gapAnchorMs) ||
        saved.gapAnchorMs < 0 ||
        saved.gapAnchorMs > saved.timelineMs)) ||
    !Number.isSafeInteger(saved.serverSeq) ||
    saved.serverSeq < 0 ||
    !Number.isSafeInteger(saved.through) ||
    saved.through < saved.serverSeq ||
    !Number.isFinite(saved.timelineMs) ||
    saved.timelineMs < 0 ||
    !Number.isFinite(saved.speed) ||
    saved.speed < 1 / 1024 ||
    saved.speed > 1024 ||
    !["follow", "paused", "playing"].includes(saved.mode) ||
    typeof saved.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.hash)
  )
    return;
  return { ...saved };
}
interface Header {
  view?: SavedView;
  key: string;
  generation: string;
  sequence: number;
  bytes: number;
  hash: string;
  used: number;
}
interface Batch {
  key: string;
  sequence: number;
  first: number;
  lines: string;
  previous: string;
  hash: string;
}
const ZERO = "0".repeat(64),
  LIMIT = 64 * 1024 * 1024,
  TOTAL = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const size = (text: string) => encoder.encode(text).length;
function header(value: unknown): Header {
  const row = value as Header;
  if (
    !row ||
    typeof row.key !== "string" ||
    row.key.length > 1024 ||
    typeof row.generation !== "string" ||
    !row.generation ||
    row.generation.length > 100 ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 0 ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 0 ||
    row.bytes > LIMIT ||
    typeof row.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.hash) ||
    !Number.isFinite(row.used)
  )
    throw new Error("Invalid browser cache header");
  return row;
}
async function digest(key: string, previous: string, lines: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`${key}\n${previous}\n${lines}`),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** All requests are scheduled synchronously from transaction/request callbacks, never after an await. */
function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  signal: AbortSignal,
  work: (
    tx: IDBTransaction,
    read: <V>(request: IDBRequest<V>, next: (value: V) => void) => void,
    result: (value: T) => void,
  ) => void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["headers", "batches"], mode);
    let value: T, failure: unknown;
    const fail = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {}
    };
    const abort = () => fail(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    tx.oncomplete = () => {
      cleanup();
      resolve(value);
    };
    tx.onabort = () => {
      cleanup();
      reject(
        failure ?? tx.error ?? new Error("Browser cache transaction aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      work(
        tx,
        (request, next) => {
          request.onsuccess = () => {
            try {
              next(request.result);
            } catch (error) {
              fail(error);
            }
          };
        },
        (result) => {
          value = result;
        },
      );
      if (signal.aborted) abort();
    } catch (error) {
      fail(error);
    }
  });
}
async function connect(
  factory: IDBFactory,
  signal: AbortSignal,
): Promise<IDBDatabase> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = factory.open("agentlive-history-v1", 1);
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => {
      if (cancelled) {
        request.transaction?.abort();
        return;
      }
      request.result.createObjectStore("headers", { keyPath: "key" });
      request.result.createObjectStore("batches", {
        keyPath: ["key", "sequence"],
      });
    };
    request.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(request.error);
    };
    request.onsuccess = () => {
      signal.removeEventListener("abort", abort);
      const db = request.result;
      db.onversionchange = () => db.close();
      if (cancelled || signal.aborted) {
        db.close();
        reject(signal.reason);
      } else resolve(db);
    };
    if (signal.aborted) abort();
  });
}
/** Optional, bounded IndexedDB receipt. The server remains authoritative. */
export class BrowserHistoryCache {
  private closed = false;
  private restoredView: BrowserView | undefined;
  loadView() {
    return this.restoredView ? { ...this.restoredView } : undefined;
  }
  private constructor(
    private readonly db: IDBDatabase,
    private readonly platform: CachePlatform,
    private position: Header,
  ) {}
  private range(key = this.position.key) {
    return this.platform.keyRange.bound(
      [key, 0],
      [key, Number.MAX_SAFE_INTEGER],
    );
  }
  private evict(tx: IDBTransaction, rows: Header[]) {
    rows.sort((a, b) => a.used - b.used || a.key.localeCompare(b.key));
    let bytes = rows.reduce((total, row) => total + row.bytes, 0),
      count = rows.length;
    for (const row of rows) {
      if (count <= 8 && bytes <= TOTAL) break;
      if (row.key === this.position.key) continue;
      tx.objectStore("headers").delete(row.key);
      tx.objectStore("batches").delete(this.range(row.key));
      count--;
      bytes -= row.bytes;
    }
  }
  static async open(
    binding: CacheBinding,
    platform: CachePlatform,
    parent: AbortSignal,
  ): Promise<BrowserHistoryCache> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    const key = canonicalJson({
      ...binding,
      serverOrigin: new URL(binding.serverOrigin).origin,
    });
    const db = await connect(platform.indexedDB, signal);
    const cache = new BrowserHistoryCache(db, platform, {
      key,
      generation: crypto.randomUUID(),
      sequence: 0,
      bytes: 0,
      hash: ZERO,
      used: Date.now(),
    });
    try {
      await transact<void>(db, "readwrite", signal, (tx, read, result) => {
        read(tx.objectStore("headers").getAll(undefined, 9), (values) => {
          const rows = values.map(header);
          if (rows.length > 8)
            throw new Error("Browser cache catalog exceeds limit");
          const existing = rows.find((row) => row.key === key);
          if (existing) cache.position = { ...existing, used: Date.now() };
          tx.objectStore("headers").put(cache.position);
          cache.evict(tx, [
            ...rows.filter((row) => row.key !== key),
            cache.position,
          ]);
          result();
        });
      });
      return cache;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  async read(
    serverBoundary: number,
    parent: AbortSignal,
  ): Promise<StoredEvent[]> {
    if (this.closed) throw new Error("Browser cache is closed");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    const snapshot = await transact<{ position: Header; batches: Batch[] }>(
      this.db,
      "readonly",
      signal,
      (tx, read, result) => {
        read(tx.objectStore("headers").get(this.position.key), (value) => {
          const position = header(value);
          if (position.sequence > serverBoundary)
            throw new CacheAheadError(
              "Saved history is ahead of this server. Clear saved history explicitly to reload.",
            );
          if (position.generation !== this.position.generation)
            throw new Error("Browser cache generation changed");
          const batches: Batch[] = [];
          let bytes = 0;
          const cursor = tx.objectStore("batches").openCursor(this.range());
          read(cursor, (current) => {
            if (!current) {
              result({ position, batches });
              return;
            }
            const batch = current.value as Batch;
            if (
              typeof batch.lines !== "string" ||
              batch.lines.length < 64 ||
              batch.lines.length > 4 * 1024 * 1024 ||
              batches.length >= LIMIT / 64
            )
              throw new Error("Browser cache batch exceeds limit");
            bytes += size(batch.lines);
            if (bytes > LIMIT)
              throw new Error("Browser cache exceeds recording limit");
            batches.push(batch);
            current.continue();
          });
        });
      },
    );
    const events: StoredEvent[] = [];
    const saved = view(snapshot.position.view);
    let anchored = !!saved && saved.through === 0 && saved.hash === ZERO;
    let hash = ZERO,
      bytes = 0,
      timeline = 0;
    for (const batch of snapshot.batches) {
      signal.throwIfAborted();
      if (
        batch.key !== this.position.key ||
        batch.previous !== hash ||
        batch.first !== events.length + 1 ||
        !batch.lines.endsWith("\n") ||
        (await digest(batch.key, hash, batch.lines)) !== batch.hash
      )
        throw new Error("Browser cache hash chain is invalid");
      hash = batch.hash;
      if (saved?.through === batch.sequence && saved.hash === hash)
        anchored = true;
      bytes += size(batch.lines);
      for (const line of batch.lines.slice(0, -1).split("\n")) {
        const event = storedEventSchema.parse(JSON.parse(line));
        if (
          event.serverSeq !== events.length + 1 ||
          event.timelineMs < timeline
        )
          throw new Error("Browser cache is not a contiguous timeline");
        timeline = event.timelineMs;
        events.push(event);
      }
      if (batch.sequence !== events.length)
        throw new Error("Browser cache batch boundary is invalid");
    }
    if (
      snapshot.position.hash !== hash ||
      snapshot.position.bytes !== bytes ||
      snapshot.position.sequence !== events.length
    )
      throw new Error("Browser cache cursor does not match its prefix");
    signal.throwIfAborted();
    this.restoredView =
      saved && anchored && saved.through <= events.length
        ? {
            serverSeq: saved.serverSeq,
            timelineMs: saved.timelineMs,
            speed: saved.speed,
            ...(saved.idleCapMs === undefined
              ? {}
              : { idleCapMs: saved.idleCapMs }),
            ...(saved.gapAnchorMs === undefined
              ? {}
              : { gapAnchorMs: saved.gapAnchorMs }),
            mode: saved.mode,
          }
        : undefined;
    this.position = snapshot.position;
    return events;
  }
  async append(
    events: readonly StoredEvent[],
    parent: AbortSignal,
  ): Promise<boolean> {
    if (this.closed) return false;
    const position = this.position;
    let sequence = position.sequence;
    const lines = events
      .map((event) => {
        if (event.serverSeq !== ++sequence)
          throw new Error("Noncontiguous browser cache append");
        return canonicalJson(storedEventSchema.parse(event)) + "\n";
      })
      .join("");
    const added = size(lines);
    if (!events.length) return true;
    if (added > 4 * 1024 * 1024 || position.bytes + added > LIMIT)
      throw new Error("Browser cache limit reached");
    const hash = await digest(position.key, position.hash, lines);
    if (this.closed) return false;
    const next = {
      ...position,
      sequence,
      bytes: position.bytes + added,
      hash,
      used: Date.now(),
    };
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    const saved = await transact<boolean>(
      this.db,
      "readwrite",
      signal,
      (tx, read, result) => {
        read(tx.objectStore("headers").getAll(undefined, 9), (values) => {
          const rows = values.map(header);
          if (rows.length > 8)
            throw new Error("Browser cache catalog exceeds limit");
          const current = rows.find((row) => row.key === position.key);
          if (
            !current ||
            current.generation !== position.generation ||
            current.sequence !== position.sequence ||
            current.hash !== position.hash ||
            current.bytes !== position.bytes
          ) {
            result(false);
            return;
          }
          tx.objectStore("batches").add({
            key: position.key,
            sequence,
            first: position.sequence + 1,
            previous: position.hash,
            hash,
            lines,
          } satisfies Batch);
          if (current.view) next.view = current.view;
          else delete next.view;
          tx.objectStore("headers").put(next);
          this.evict(tx, [
            ...rows.filter((row) => row.key !== position.key),
            next,
          ]);
          result(true);
        });
      },
    );
    if (saved) this.position = next;
    return saved;
  }
  async saveView(value: BrowserView, parent: AbortSignal): Promise<boolean> {
    if (this.closed) return false;
    const position = this.position;
    const saved = view({
      ...value,
      through: position.sequence,
      hash: position.hash,
    });
    if (!saved) throw new Error("Invalid browser playback checkpoint");
    return transact<boolean>(
      this.db,
      "readwrite",
      AbortSignal.any([parent, AbortSignal.timeout(10000)]),
      (tx, read, result) => {
        read(tx.objectStore("headers").get(position.key), (row) => {
          if (!row) {
            result(false);
            return;
          }
          const current = header(row);
          if (
            current.generation !== position.generation ||
            current.sequence < position.sequence
          ) {
            result(false);
            return;
          }
          const write = (anchor: boolean) => {
            if (anchor)
              tx.objectStore("headers").put({ ...current, view: saved });
            result(anchor);
          };
          if (current.sequence === position.sequence)
            write(current.hash === position.hash);
          else if (position.sequence === 0) write(position.hash === ZERO);
          else
            read(
              tx.objectStore("batches").get([position.key, position.sequence]),
              (batch) => write(batch?.hash === position.hash),
            );
        });
      },
    );
  }
  async clear(parent: AbortSignal): Promise<void> {
    this.closed = true;
    try {
      await transact<void>(
        this.db,
        "readwrite",
        AbortSignal.any([parent, AbortSignal.timeout(10000)]),
        (tx, read, result) => {
          read(tx.objectStore("headers").get(this.position.key), (value) => {
            if (value?.generation === this.position.generation) {
              tx.objectStore("headers").delete(this.position.key);
              tx.objectStore("batches").delete(this.range());
            }
            result();
          });
        },
      );
    } finally {
      this.db.close();
    }
  }
  close() {
    this.closed = true;
    this.db.close();
  }
}

export async function clearSavedHistories(
  platform: CachePlatform,
  parent: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const request = platform.indexedDB.deleteDatabase("agentlive-history-v1");
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    request.onsuccess = () => {
      cleanup();
      resolve();
    };
    request.onerror = () => {
      cleanup();
      reject(request.error);
    };
    if (signal.aborted) abort();
  });
}
export function browserCachePlatform(): CachePlatform | undefined {
  try {
    if (
      globalThis.indexedDB &&
      globalThis.IDBKeyRange &&
      globalThis.crypto?.subtle
    )
      return {
        indexedDB: globalThis.indexedDB,
        keyRange: globalThis.IDBKeyRange,
      };
  } catch {}
}
