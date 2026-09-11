import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  hashSchema,
  ProtocolError,
  validateTextReference,
  CONTENT_PAGE_UNITS,
  type TextReference,
} from "@agentlive/protocol";
import { syncDirectory } from "./atomic.js";

/** One collection attempt's disk-backed marks. Never reopened or reused after a crash.
 * Tracing must finish before seal; callers hold the same root/write barrier through sweep.
 * SQLite's page cache is bounded; mark count does not determine JS heap usage.
 */
export class ContentMarks {
  private state: "building" | "sealed" | "failed" | "closed" = "building";
  private readonly insert: StatementSync;
  private readonly lookup: StatementSync;
  private readonly tracedLookup: StatementSync;
  private readonly tracedInsert: StatementSync;
  private constructor(
    private readonly directory: string,
    private readonly db: DatabaseSync,
  ) {
    this.insert = db.prepare("INSERT OR IGNORE INTO marks(hash) VALUES (?)");
    this.tracedLookup = db.prepare(
      "SELECT bytes, units FROM traced WHERE hash = ?",
    );
    this.tracedInsert = db.prepare(
      "INSERT OR IGNORE INTO traced(hash, bytes, units) VALUES (?, ?, ?)",
    );
    this.lookup = db.prepare("SELECT 1 AS present FROM marks WHERE hash = ?");
  }
  static async create(parent: string): Promise<ContentMarks> {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, "marks-"));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(directory, "marks.sqlite"));
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; CREATE TABLE marks(hash TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID; CREATE TABLE traced(hash TEXT PRIMARY KEY NOT NULL, bytes INTEGER NOT NULL, units INTEGER NOT NULL) WITHOUT ROWID; BEGIN IMMEDIATE;",
      );
      return new ContentMarks(directory, db);
    } catch (error) {
      db?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private require(expected: "building" | "sealed") {
    if (this.state !== expected)
      throw new ProtocolError(
        "precondition_failed",
        `Content marks are ${this.state}`,
      );
  }
  add(hash: string, signal?: AbortSignal): void {
    this.require("building");
    try {
      signal?.throwIfAborted();
      hashSchema.parse(hash);
      this.insert.run(hash);
      signal?.throwIfAborted();
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
  /** Attempt-local memoization only; caller records after all codec pages have been marked. */
  traced(ref: TextReference, signal?: AbortSignal): boolean {
    this.require("building");
    try {
      signal?.throwIfAborted();
      validateTextReference(ref, 4096 * CONTENT_PAGE_UNITS);
      const prior = this.tracedLookup.get(ref.hash);
      if (prior && (prior.bytes !== ref.byteSize || prior.units !== ref.units))
        throw new ProtocolError(
          "corrupt_storage",
          "Traced content descriptor differs",
        );
      return prior !== undefined;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
  recordTrace(ref: TextReference, signal?: AbortSignal): void {
    if (this.traced(ref, signal)) return;
    try {
      this.tracedInsert.run(ref.hash, ref.byteSize, ref.units);
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
  /** Commit and sync before allowing any negative lookup to authorize reclamation. */
  async seal(signal?: AbortSignal): Promise<void> {
    this.require("building");
    // Block additions while the directory sync is pending.
    this.state = "failed";
    signal?.throwIfAborted();
    this.db.exec("COMMIT; PRAGMA query_only=ON;");
    await syncDirectory(this.directory);
    signal?.throwIfAborted();
    if ((this.state as string) === "closed")
      throw new ProtocolError(
        "precondition_failed",
        "Content marks are closed",
      );
    this.state = "sealed";
  }
  has(hash: string, signal?: AbortSignal): boolean {
    this.require("sealed");
    try {
      signal?.throwIfAborted();
      hashSchema.parse(hash);
      const result = this.lookup.get(hash);
      signal?.throwIfAborted();
      return result !== undefined;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    try {
      this.db.close();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
