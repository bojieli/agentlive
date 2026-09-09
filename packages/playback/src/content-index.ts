import {
  canonicalJson,
  ProtocolError,
  snapshotContentReferenceSchema,
} from "@agentlive/protocol";
import type { ContentReference, SnapshotContent } from "./snapshot.js";
export interface IndexRoot {
  ref: ContentReference;
  count: number;
  first: string;
  last: string;
}
export type IndexEntry = [string, ContentReference];
type Node =
  | { kind: "leaf"; entries: IndexEntry[] }
  | { kind: "branch"; children: IndexRoot[] };
const MAX_NODE = 32768,
  FANOUT = 32;
function corrupt(): never {
  throw new ProtocolError("corrupt_storage", "Invalid content index node");
}
function key(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512;
}
function copyRef(value: unknown): ContentReference {
  const result = snapshotContentReferenceSchema.safeParse(value);
  if (!result.success) corrupt();
  return result.data;
}
function root(value: IndexRoot): IndexRoot {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "count,first,last,ref" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    !key(value.first) ||
    !key(value.last) ||
    value.first > value.last
  )
    corrupt();
  const ref = copyRef(value.ref);
  if (ref.units > MAX_NODE) corrupt();
  return { ref, count: value.count, first: value.first, last: value.last };
}
function equal(a: ContentReference, b: ContentReference) {
  return a.hash === b.hash && a.byteSize === b.byteSize && a.units === b.units;
}
/** Immutable ordered index. Mutations copy only a bounded tree path; values remain opaque content references. */
export class ContentIndex {
  constructor(private readonly content: SnapshotContent) {}
  private async load(span: IndexRoot, signal?: AbortSignal): Promise<Node> {
    signal?.throwIfAborted();
    const text = await this.content.read(span.ref, 0, span.ref.units, signal);
    signal?.throwIfAborted();
    if (text.length !== span.ref.units) corrupt();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return corrupt();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      corrupt();
    const { version, ...body } = parsed as Record<string, unknown>;
    if (
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 1
    )
      throw new ProtocolError(
        "version_unsupported",
        "Content index version is unsupported",
      );
    if (version !== 1) corrupt();
    const node = body as Node;
    if (node?.kind === "leaf") {
      if (
        Object.keys(node).sort().join(",") !== "entries,kind" ||
        !Array.isArray(node.entries) ||
        !node.entries.length ||
        node.entries.length > FANOUT ||
        node.entries.length !== span.count
      )
        corrupt();
      let previous: string | undefined;
      for (const entry of node.entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !key(entry[0]) ||
          (previous !== undefined && entry[0] <= previous)
        )
          corrupt();
        entry[1] = copyRef(entry[1]);
        previous = entry[0];
      }
      if (node.entries[0]![0] !== span.first || previous !== span.last)
        corrupt();
      return node;
    }
    if (
      node?.kind !== "branch" ||
      Object.keys(node).sort().join(",") !== "children,kind" ||
      !Array.isArray(node.children) ||
      !node.children.length ||
      node.children.length > FANOUT
    )
      corrupt();
    let count = 0,
      previous: string | undefined;
    for (let i = 0; i < node.children.length; i++) {
      const child = root(node.children[i]!);
      if (previous !== undefined && child.first <= previous) corrupt();
      count += child.count;
      previous = child.last;
      node.children[i] = child;
    }
    if (
      !Number.isSafeInteger(count) ||
      count !== span.count ||
      node.children[0]!.first !== span.first ||
      previous !== span.last
    )
      corrupt();
    return node;
  }
  private async save(node: Node, signal?: AbortSignal): Promise<IndexRoot[]> {
    signal?.throwIfAborted();
    const items = node.kind === "leaf" ? node.entries : node.children;
    if (!items.length) return [];
    const text = canonicalJson({ version: 1, ...node });
    if (items.length > FANOUT || text.length > MAX_NODE) {
      if (items.length === 1)
        throw new RangeError("Index entry exceeds node capacity");
      const middle = Math.floor(items.length / 2);
      const left: Node =
        node.kind === "leaf"
          ? { kind: "leaf", entries: node.entries.slice(0, middle) }
          : { kind: "branch", children: node.children.slice(0, middle) };
      const right: Node =
        node.kind === "leaf"
          ? { kind: "leaf", entries: node.entries.slice(middle) }
          : { kind: "branch", children: node.children.slice(middle) };
      return [
        ...(await this.save(left, signal)),
        ...(await this.save(right, signal)),
      ];
    }
    const ref = copyRef(await this.content.put(text, signal));
    signal?.throwIfAborted();
    if (ref.units !== text.length) corrupt();
    const span =
      node.kind === "leaf"
        ? {
            ref,
            count: node.entries.length,
            first: node.entries[0]![0],
            last: node.entries.at(-1)![0],
          }
        : {
            ref,
            count: node.children.reduce((sum, child) => sum + child.count, 0),
            first: node.children[0]!.first,
            last: node.children.at(-1)!.last,
          };
    return [root(span)];
  }
  /** Build a sorted index in one pass without retaining the full key catalog. */
  async build(
    entries: Iterable<IndexEntry>,
    signal?: AbortSignal,
  ): Promise<IndexRoot | null> {
    const levels: IndexRoot[][] = [];
    let leaf: IndexEntry[] = [],
      previous: string | undefined;
    const add = async (level: number, span: IndexRoot): Promise<void> => {
      if (level > 64) corrupt();
      const group = (levels[level] ??= []);
      if (
        group.length &&
        (group.length === FANOUT ||
          canonicalJson({
            version: 1,
            kind: "branch",
            children: [...group, span],
          }).length > MAX_NODE)
      ) {
        levels[level] = [];
        const [parent] = await this.save(
          { kind: "branch", children: group },
          signal,
        );
        await add(level + 1, parent!);
      }
      levels[level]!.push(span);
    };
    const flush = async () => {
      if (!leaf.length) return;
      const children = await this.save({ kind: "leaf", entries: leaf }, signal);
      for (const child of children) await add(0, child);
      leaf = [];
    };
    signal?.throwIfAborted();
    for (const [name, reference] of entries) {
      signal?.throwIfAborted();
      if (!key(name) || (previous !== undefined && name <= previous))
        throw new RangeError(
          "Content index input must have strictly increasing keys",
        );
      const entry: IndexEntry = [name, copyRef(reference)];
      if (
        leaf.length &&
        (leaf.length === FANOUT ||
          canonicalJson({ version: 1, kind: "leaf", entries: [...leaf, entry] })
            .length > MAX_NODE)
      )
        await flush();
      leaf.push(entry);
      previous = name;
    }
    await flush();
    for (let level = 0; level < levels.length; level++) {
      const group = levels[level]!;
      if (!group.length) continue;
      if (
        group.length === 1 &&
        levels.slice(level + 1).every((items) => !items.length)
      ) {
        signal?.throwIfAborted();
        return group[0]!;
      }
      levels[level] = [];
      const [parent] = await this.save(
        { kind: "branch", children: group },
        signal,
      );
      await add(level + 1, parent!);
    }
    signal?.throwIfAborted();
    return null;
  }
  async get(
    input: IndexRoot | null,
    name: string,
    signal?: AbortSignal,
  ): Promise<ContentReference | undefined> {
    if (!key(name)) throw new RangeError("Invalid content index key");
    signal?.throwIfAborted();
    let span = input === null ? null : root(input);
    for (let depth = 0; span; depth++) {
      if (depth > 64) corrupt();
      const node = await this.load(span, signal);
      if (node.kind === "leaf")
        return node.entries.find(([entry]) => entry === name)?.[1];
      span =
        node.children.find(
          (child) => child.first <= name && name <= child.last,
        ) ?? null;
    }
    return undefined;
  }
  /** Read at most 32 entries in key order without loading value content. */
  async entries(
    input: IndexRoot | null,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<IndexEntry[]> {
    const span = input === null ? null : root(input);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > (span?.count ?? 0) ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > FANOUT
    )
      throw new RangeError("Invalid content index range");
    signal?.throwIfAborted();
    const output: IndexEntry[] = [];
    const visit = async (
      current: IndexRoot,
      start: number,
      amount: number,
      depth: number,
    ): Promise<void> => {
      if (depth > 64) corrupt();
      const node = await this.load(current, signal);
      if (node.kind === "leaf") {
        output.push(...node.entries.slice(start, start + amount));
        return;
      }
      for (const child of node.children) {
        if (!amount) break;
        if (start >= child.count) {
          start -= child.count;
          continue;
        }
        const take = Math.min(amount, child.count - start);
        await visit(child, start, take, depth + 1);
        amount -= take;
        start = 0;
      }
    };
    if (span)
      await visit(span, offset, Math.min(limit, span.count - offset), 0);
    signal?.throwIfAborted();
    return output;
  }
  async set(
    input: IndexRoot | null,
    name: string,
    value: ContentReference,
    signal?: AbortSignal,
  ): Promise<IndexRoot> {
    const result = await this.change(input, name, copyRef(value), signal);
    if (!result) throw new Error("Index insertion returned no root");
    return result;
  }
  delete(
    input: IndexRoot | null,
    name: string,
    signal?: AbortSignal,
  ): Promise<IndexRoot | null> {
    return this.change(input, name, null, signal);
  }
  private async change(
    input: IndexRoot | null,
    name: string,
    value: ContentReference | null,
    signal?: AbortSignal,
  ): Promise<IndexRoot | null> {
    if (!key(name)) throw new RangeError("Invalid content index key");
    signal?.throwIfAborted();
    const original = input === null ? null : root(input);
    const visit = async (
      span: IndexRoot,
      depth: number,
    ): Promise<IndexRoot[]> => {
      if (depth > 64) corrupt();
      const node = await this.load(span, signal);
      if (node.kind === "leaf") {
        const at = node.entries.findIndex(([entry]) => entry >= name);
        const exists = at >= 0 && node.entries[at]![0] === name;
        if (
          (value === null && !exists) ||
          (value && exists && equal(node.entries[at]![1], value))
        )
          return [span];
        if (value === null) node.entries.splice(at, 1);
        else if (exists) node.entries[at] = [name, value];
        else
          node.entries.splice(at < 0 ? node.entries.length : at, 0, [
            name,
            value,
          ]);
        return this.save(node, signal);
      }
      const found = node.children.findIndex((child) => child.last >= name);
      const at = found < 0 ? node.children.length - 1 : found;
      const child = node.children[at]!;
      if (value === null && (name < child.first || name > child.last))
        return [span];
      const changed = await visit(child, depth + 1);
      if (changed.length === 1 && equal(changed[0]!.ref, child.ref))
        return [span];
      node.children.splice(at, 1, ...changed);
      return this.save(node, signal);
    };
    let spans = original
      ? await visit(original, 0)
      : value
        ? await this.save({ kind: "leaf", entries: [[name, value]] }, signal)
        : [];
    while (spans.length > 1)
      spans = await this.save({ kind: "branch", children: spans }, signal);
    let result = spans[0] ?? null;
    // Collapse unary roots after deletion; internal nodes retain their level.
    if (value === null)
      for (let depth = 0; result; depth++) {
        if (depth > 64) corrupt();
        const node = await this.load(result, signal);
        if (node.kind !== "branch" || node.children.length !== 1) break;
        result = node.children[0]!;
      }
    signal?.throwIfAborted();
    return result;
  }
}
