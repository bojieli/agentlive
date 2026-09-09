import { canonicalJson } from "@agentlive/protocol";
import type { SnapshotReadCache } from "@agentlive/client";

const DATABASE = "agentlive-snapshot-ranges-v1";
const MAX_ROWS = 256;
interface Row {
  key: string;
  text: string;
  hash: string;
  used: number;
}
async function checksum(key: string, text: string) {
  const bytes = new TextEncoder().encode(canonicalJson({ key, text }));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Optional bounded derivative cache. Each row contains at most 65,536 UTF-16 units. */
export class BrowserSnapshotCache implements SnapshotReadCache {
  private readonly stop = new AbortController();
  private pending = 0;
  private constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => this.close();
  }
  static async open(factory: IDBFactory, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    signal.throwIfAborted();
    return new Promise<BrowserSnapshotCache>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.onupgradeneeded = () => {
        if (signal.aborted) {
          request.transaction?.abort();
          return;
        }
        const rows = request.result.createObjectStore("ranges", {
          keyPath: "key",
        });
        rows.createIndex("used", "used");
      };
      request.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(request.error);
      };
      request.onsuccess = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          request.result.close();
          reject(signal.reason);
        } else resolve(new BrowserSnapshotCache(request.result));
      };
    });
  }
  private async run<T>(
    key: string,
    parent: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    if (typeof key !== "string" || key.length > 2048)
      throw new RangeError("Invalid snapshot cache key");
    const signal = AbortSignal.any([
      parent,
      this.stop.signal,
      AbortSignal.timeout(10000),
    ]);
    signal.throwIfAborted();
    if (this.pending >= 16) throw new Error("Snapshot cache is at capacity");
    this.pending++;
    try {
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } finally {
      this.pending--;
    }
  }
  private transaction<T>(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    work: (store: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("ranges", mode);
      let value: T, failure: unknown;
      const abort = () => {
        failure = signal.reason;
        try {
          tx.abort();
        } catch {}
      };
      signal.addEventListener("abort", abort, { once: true });
      tx.oncomplete = () => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      tx.onabort = () => {
        signal.removeEventListener("abort", abort);
        reject(
          failure ??
            tx.error ??
            new Error("Snapshot cache transaction aborted"),
        );
      };
      try {
        work(tx.objectStore("ranges"), (result) => {
          value = result;
        });
        if (signal.aborted) abort();
      } catch (error) {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      }
    });
  }
  read(key: string, parent: AbortSignal): Promise<string | undefined> {
    return this.run(key, parent, async (signal) => {
      const row = await this.transaction<Row | undefined>(
        "readonly",
        signal,
        (store, result) => {
          const request = store.get(key);
          request.onsuccess = () => result(request.result);
        },
      );
      if (!row) return;
      if (
        row.key !== key ||
        typeof row.text !== "string" ||
        row.text.length > 65536 ||
        typeof row.hash !== "string" ||
        row.hash.length !== 64 ||
        row.hash !== (await checksum(key, row.text))
      ) {
        // Corrupt derivative data is a miss; the client fetches the authoritative range.
        return;
      }
      return row.text;
    });
  }
  write(key: string, text: string, parent: AbortSignal): Promise<void> {
    return this.run(key, parent, async (signal) => {
      if (typeof text !== "string" || text.length > 65536)
        throw new RangeError("Snapshot cache range exceeds limit");
      const row: Row = {
        key,
        text,
        hash: await checksum(key, text),
        used: Date.now(),
      };
      signal.throwIfAborted();
      await this.transaction<void>("readwrite", signal, (store, result) => {
        store.put(row);
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - MAX_ROWS;
          if (excess <= 0) {
            result();
            return;
          }
          const cursor = store.index("used").openKeyCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (excess <= 0) {
              result();
              return;
            }
            if (!item) {
              store.transaction.abort();
              return;
            }
            store.delete(item.primaryKey);
            excess--;
            item.continue();
          };
        };
      });
    });
  }
  static async clear(factory: IDBFactory, signal: AbortSignal) {
    const cache = await BrowserSnapshotCache.open(factory, signal);
    try {
      await cache.run("clear", signal, (active) =>
        cache.transaction<void>("readwrite", active, (store, result) => {
          store.clear();
          result();
        }),
      );
    } finally {
      cache.close();
    }
  }
  close() {
    this.stop.abort(new Error("Snapshot cache is closed"));
    this.db.close();
  }
}
