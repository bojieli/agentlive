import { canonicalJson, ProtocolError, idSchema } from "@agentlive/protocol";
import type { RecordingState } from "./index.js";
export interface ContentReference {
  hash: string;
  byteSize: number;
  units: number;
}
/** Reads must verify content identity and exact requested length before resolving. */
export interface SnapshotContent {
  put(text: string, signal?: AbortSignal): Promise<ContentReference>;
  read(
    ref: ContentReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string>;
}
export type SnapshotValue =
  | null
  | boolean
  | number
  | string
  | { kind: "undefined" }
  | { kind: "text"; ref: ContentReference }
  | { kind: "array" | "object" | "map"; ref: ContentReference; count: number };
export type SnapshotEntry = [string | number, SnapshotValue];
type Child = { ref: ContentReference; count: number };
type Tree =
  | { kind: "leaf"; entries: SnapshotEntry[] }
  | { kind: "branch"; children: Child[] };
export interface SnapshotBinding {
  streamId: string;
  revision: string;
}
export interface SnapshotManifest extends SnapshotBinding {
  version: 1;
  reducerVersion: 1;
  serverSeq: number;
  timelineMs: number;
  state: SnapshotValue;
}
const MAX_NODE = 32768,
  FANOUT = 32;
function bad(message: string): never {
  throw new ProtocolError("corrupt_storage", message);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function reference(value: unknown): value is ContentReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as ContentReference;
  return (
    Object.keys(ref).sort().join(",") === "byteSize,hash,units" &&
    typeof ref.hash === "string" &&
    /^[a-f0-9]{64}$/.test(ref.hash) &&
    integer(ref.byteSize) &&
    ref.byteSize > 0 &&
    ref.byteSize <= 1048576 &&
    integer(ref.units) &&
    ref.units <= 67108864
  );
}
function validValue(value: unknown): value is SnapshotValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 256)
  )
    return true;
  if (!value || typeof value !== "object") return false;
  const item = value as Exclude<
    SnapshotValue,
    null | boolean | number | string
  >;
  const keys = Object.keys(item).sort().join(",");
  if (item.kind === "undefined") return keys === "kind";
  if (item.kind === "text") return keys === "kind,ref" && reference(item.ref);
  return (
    ["array", "object", "map"].includes(item.kind) &&
    keys === "count,kind,ref" &&
    "count" in item &&
    integer(item.count) &&
    reference(item.ref)
  );
}
/** Build from an immutable reference-reducer state; only a completed root is publishable. */
export async function createSnapshot(
  state: RecordingState,
  binding: SnapshotBinding,
  content: SnapshotContent,
  signal?: AbortSignal,
): Promise<ContentReference> {
  binding = { streamId: binding.streamId, revision: binding.revision };
  idSchema.parse(binding.streamId);
  idSchema.parse(binding.revision);
  const serverSeq = state.appliedSeq,
    timelineMs = state.timelineMs;
  if (!integer(serverSeq) || !Number.isFinite(timelineMs) || timelineMs < 0)
    throw new RangeError("Invalid snapshot boundary");
  const parents = new Set<object>();
  const written = new Map<string, ContentReference>();
  let cachedUnits = 0;
  async function put(text: string) {
    signal?.throwIfAborted();
    const existing = written.get(text);
    if (existing) {
      written.delete(text);
      written.set(text, existing);
      return existing;
    }
    const ref = { ...(await content.put(text, signal)) };
    if (!reference(ref) || ref.units !== text.length)
      throw new Error("Content store returned an invalid reference");
    signal?.throwIfAborted();
    Object.freeze(ref);
    if (text.length <= 65536) {
      while (written.size >= 64 || cachedUnits + text.length > 262144) {
        const oldest = written.keys().next().value!;
        written.delete(oldest);
        cachedUnits -= oldest.length;
      }
      written.set(text, ref);
      cachedUnits += text.length;
    }
    return ref;
  }
  async function write(value: unknown) {
    signal?.throwIfAborted();
    const text = canonicalJson(value);
    if (text.length > MAX_NODE)
      throw new RangeError("Snapshot node exceeds size limit");
    const ref = await put(text);
    signal?.throwIfAborted();
    return ref;
  }
  async function encode(value: unknown, depth: number): Promise<SnapshotValue> {
    signal?.throwIfAborted();
    if (depth > 64) throw new RangeError("Snapshot nesting exceeds limit");
    if (value === undefined) return { kind: "undefined" };
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    if (typeof value === "string")
      return value.length <= 256
        ? value
        : { kind: "text", ref: await put(value) };
    if (typeof value !== "object" || parents.has(value))
      throw new TypeError("Invalid snapshot value");
    const kind =
      value instanceof Map ? "map" : Array.isArray(value) ? "array" : "object";
    if (
      kind === "object" &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new TypeError("Snapshot requires plain objects");
    parents.add(value);
    try {
      const levels: Child[][] = [];
      let leaf: SnapshotEntry[] = [],
        leafUnits = 0,
        count = 0;
      async function add(level: number, child: Child): Promise<void> {
        const group = (levels[level] ??= []);
        group.push(child);
        if (group.length === FANOUT) {
          const branch = {
            ref: await write({ kind: "branch", children: group }),
            count: group.reduce((sum, item) => sum + item.count, 0),
          };
          levels[level] = [];
          await add(level + 1, branch);
        }
      }
      async function flush() {
        if (!leaf.length) return;
        await add(0, {
          ref: await write({ kind: "leaf", entries: leaf }),
          count: leaf.length,
        });
        leaf = [];
        leafUnits = 0;
      }
      const entries: Iterable<[unknown, unknown]> =
        value instanceof Map
          ? value
          : Array.isArray(value)
            ? value.entries()
            : Object.entries(value);
      for (const [key, item] of entries) {
        if (!(
          (typeof key === "string" && key.length <= 512) ||
          (typeof key === "number" && Number.isFinite(key))
        ))
          throw new TypeError("Invalid snapshot key");
        const entry: SnapshotEntry = [key, await encode(item, depth + 1)];
        const units = canonicalJson(entry).length;
        if (
          leaf.length &&
          (leaf.length === FANOUT || leafUnits + units > 24000)
        )
          await flush();
        leaf.push(entry);
        leafUnits += units;
        count++;
      }
      await flush();
      if (!count)
        return { kind, ref: await write({ kind: "leaf", entries: [] }), count };
      for (let level = 0; level < levels.length; level++) {
        const group = levels[level]!;
        if (!group.length) continue;
        if (
          group.length === 1 &&
          levels.slice(level + 1).every((items) => !items.length)
        )
          return { kind, ref: group[0]!.ref, count };
        levels[level] = [];
        await add(level + 1, {
          ref: await write({ kind: "branch", children: group }),
          count: group.reduce((sum, item) => sum + item.count, 0),
        });
      }
      throw new Error("Snapshot tree construction failed");
    } finally {
      parents.delete(value);
    }
  }
  const root = await encode(state, 0);
  if (state.appliedSeq !== serverSeq || state.timelineMs !== timelineMs)
    throw new Error("Snapshot state changed during creation");
  return write({
    version: 1,
    reducerVersion: 1,
    ...binding,
    serverSeq,
    timelineMs,
    state: root,
  } satisfies SnapshotManifest);
}
export class SnapshotReader {
  private constructor(
    readonly manifest: SnapshotManifest,
    private readonly content: SnapshotContent,
  ) {}
  private static async json(
    content: SnapshotContent,
    ref: ContentReference,
    signal?: AbortSignal,
  ): Promise<unknown> {
    ref = { ...ref };
    if (!reference(ref) || ref.units > MAX_NODE)
      bad("Invalid snapshot node reference");
    signal?.throwIfAborted();
    const text = await content.read(ref, 0, ref.units, signal);
    signal?.throwIfAborted();
    if (text.length !== ref.units) bad("Incomplete snapshot node");
    try {
      return JSON.parse(text);
    } catch {
      return bad("Invalid snapshot JSON");
    }
  }
  static async open(
    ref: ContentReference,
    binding: SnapshotBinding,
    content: SnapshotContent,
    signal?: AbortSignal,
  ): Promise<SnapshotReader> {
    binding = { streamId: binding.streamId, revision: binding.revision };
    idSchema.parse(binding.streamId);
    idSchema.parse(binding.revision);
    const manifest = (await this.json(
      content,
      ref,
      signal,
    )) as SnapshotManifest;
    if (
      manifest &&
      ((integer(manifest.version) && manifest.version > 1) ||
        (integer(manifest.reducerVersion) && manifest.reducerVersion > 1))
    )
      throw new ProtocolError(
        "version_unsupported",
        "Snapshot format or reducer version is unsupported",
      );
    if (
      !manifest ||
      Object.keys(manifest).sort().join(",") !==
        "reducerVersion,revision,serverSeq,state,streamId,timelineMs,version" ||
      manifest.version !== 1 ||
      manifest.reducerVersion !== 1 ||
      !integer(manifest.serverSeq) ||
      !Number.isFinite(manifest.timelineMs) ||
      manifest.timelineMs < 0 ||
      !validValue(manifest.state) ||
      typeof manifest.state !== "object" ||
      manifest.state?.kind !== "object"
    )
      bad("Invalid snapshot manifest");
    if (
      manifest.streamId !== binding.streamId ||
      manifest.revision !== binding.revision
    )
      throw new ProtocolError(
        "revision_changed",
        "Snapshot binding differs from recording",
      );
    const reader = new SnapshotReader(manifest, content);
    const mapFields = [
      "agents",
      "tasks",
      "monitors",
      "goals",
      "interactions",
      "plans",
      "messages",
      "tools",
      "changes",
      "artifacts",
      "references",
      "replacements",
    ];
    const expected = [
      "appliedSeq",
      "timelineMs",
      "title",
      "lifecycle",
      "gaps",
      ...mapFields,
    ].sort();
    const root = await reader.entries(manifest.state, 0, 32, signal);
    if (
      !("count" in manifest.state) ||
      manifest.state.count !== expected.length ||
      root
        .map(([key]) => key)
        .sort()
        .join(",") !== expected.join(",")
    )
      bad("Invalid snapshot state fields");
    const fields = new Map(root);
    if (
      fields.get("appliedSeq") !== manifest.serverSeq ||
      fields.get("timelineMs") !== manifest.timelineMs ||
      !["open", "ended"].includes(fields.get("lifecycle") as string)
    )
      bad("Snapshot state boundary mismatch");
    const title = fields.get("title");
    if (!(
      typeof title === "string" ||
      (title && typeof title === "object" && title.kind === "text")
    ))
      bad("Invalid snapshot title");
    for (const field of [...mapFields, "gaps"]) {
      const value = fields.get(field);
      if (
        !value ||
        typeof value !== "object" ||
        value.kind !== (field === "gaps" ? "array" : "map")
      )
        bad("Invalid snapshot state container");
    }
    Object.freeze(manifest.state.ref);
    Object.freeze(manifest.state);
    Object.freeze(manifest);
    return reader;
  }
  async entries(
    value: SnapshotValue,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SnapshotEntry[]> {
    if (
      !validValue(value) ||
      !value ||
      typeof value !== "object" ||
      !("count" in value)
    )
      throw new TypeError("Snapshot value is not a container");
    if (
      !integer(offset) ||
      offset > value.count ||
      !integer(limit) ||
      limit > 32
    )
      throw new RangeError("Invalid snapshot entry range");
    const output: SnapshotEntry[] = [];
    async function visit(
      content: SnapshotContent,
      child: Child,
      start: number,
      amount: number,
      depth: number,
    ): Promise<void> {
      if (depth > 64) bad("Snapshot tree nesting exceeds limit");
      const node = (await SnapshotReader.json(
        content,
        child.ref,
        signal,
      )) as Tree;
      if (node?.kind === "leaf") {
        if (
          Object.keys(node).sort().join(",") !== "entries,kind" ||
          !Array.isArray(node.entries) ||
          node.entries.length > FANOUT ||
          node.entries.length !== child.count
        )
          bad("Invalid snapshot leaf");
        for (const entry of node.entries)
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            !(
              (typeof entry[0] === "string" && entry[0].length <= 512) ||
              (typeof entry[0] === "number" && Number.isFinite(entry[0]))
            ) ||
            !validValue(entry[1])
          )
            bad("Invalid snapshot entry");
        output.push(...node.entries.slice(start, start + amount));
        return;
      }
      if (
        node?.kind !== "branch" ||
        Object.keys(node).sort().join(",") !== "children,kind" ||
        !Array.isArray(node.children) ||
        !node.children.length ||
        node.children.length > FANOUT
      )
        bad("Invalid snapshot branch");
      let total = 0;
      for (const item of node.children) {
        if (
          !item ||
          Object.keys(item).sort().join(",") !== "count,ref" ||
          !reference(item.ref) ||
          !integer(item.count) ||
          item.count < 1
        )
          bad("Invalid snapshot branch reference");
        total += item.count;
      }
      if (!Number.isSafeInteger(total) || total !== child.count)
        bad("Snapshot count mismatch");
      for (const item of node.children) {
        if (!amount) break;
        if (start >= item.count) {
          start -= item.count;
          continue;
        }
        const take = Math.min(amount, item.count - start);
        await visit(content, item, start, take, depth + 1);
        amount -= take;
        start = 0;
      }
    }
    signal?.throwIfAborted();
    const amount = Math.min(limit, value.count - offset);
    await visit(this.content, value, offset, amount, 0);
    signal?.throwIfAborted();
    return output;
  }
  async text(
    value: SnapshotValue,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      !validValue(value) ||
      !integer(offset) ||
      !integer(length) ||
      length > 65536
    )
      throw new RangeError("Invalid snapshot text range");
    signal?.throwIfAborted();
    if (typeof value === "string") {
      if (offset + length > value.length)
        throw new RangeError("Invalid snapshot text range");
      return value.slice(offset, offset + length);
    }
    if (
      !value ||
      typeof value !== "object" ||
      value.kind !== "text" ||
      offset + length > value.ref.units
    )
      throw new RangeError("Invalid snapshot text range");
    const text = await this.content.read(value.ref, offset, length, signal);
    signal?.throwIfAborted();
    if (text.length !== length) bad("Incomplete snapshot text");
    return text;
  }
  /** Bounded reference/test helper, not a production full-history loading path. */
  async materialize(
    maxUnits = 16 * 1024 * 1024,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!integer(maxUnits) || !maxUnits)
      throw new RangeError("Invalid materialization budget");
    let units = 0;
    const charge = (count: number) => {
      units += count;
      if (units > maxUnits)
        throw new RangeError("Snapshot materialization budget exceeded");
    };
    const decode = async (
      value: SnapshotValue,
      depth: number,
    ): Promise<unknown> => {
      signal?.throwIfAborted();
      if (depth > 64) bad("Snapshot value nesting exceeds limit");
      charge(32);
      if (value === null || typeof value !== "object") {
        if (typeof value === "string") charge(value.length);
        return value;
      }
      if (value.kind === "undefined") return undefined;
      if (value.kind === "text") {
        charge(value.ref.units);
        let text = "";
        for (let offset = 0; offset < value.ref.units; offset += 65536)
          text += await this.text(
            value,
            offset,
            Math.min(65536, value.ref.units - offset),
            signal,
          );
        return text;
      }
      const result =
        value.kind === "map"
          ? new Map<string | number, unknown>()
          : value.kind === "array"
            ? ([] as unknown[])
            : ({} as Record<string, unknown>);
      const seen = new Set<string | number>();
      if (!value.count) await this.entries(value, 0, 0, signal);
      for (let offset = 0; offset < value.count; offset += 32)
        for (const [key, item] of await this.entries(
          value,
          offset,
          32,
          signal,
        )) {
          if (
            seen.has(key) ||
            (value.kind === "array" && key !== seen.size) ||
            (value.kind === "object" && typeof key !== "string")
          )
            bad("Invalid snapshot container keys");
          seen.add(key);
          charge(typeof key === "string" ? key.length : 8);
          const decoded = await decode(item, depth + 1);
          if (result instanceof Map) result.set(key, decoded);
          else
            Object.defineProperty(result, key, {
              value: decoded,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
      return result;
    };
    return decode(this.manifest.state, 0);
  }
}
