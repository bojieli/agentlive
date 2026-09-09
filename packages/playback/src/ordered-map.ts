import {
  canonicalJson,
  ProtocolError,
  snapshotContentReferenceSchema,
} from "@agentlive/protocol";
import {
  ContentIndex,
  copyIndexRoot,
  type IndexRoot,
} from "./content-index.js";
import type { ContentReference, SnapshotContent } from "./snapshot.js";
export type OrderedMapKey = string | number;
export interface OrderedMapRoot {
  version: 1;
  size: number;
  nextOrdinal: number;
  byKey: IndexRoot | null;
  byOrder: IndexRoot | null;
}
type Entry = {
  version: 1;
  key: OrderedMapKey;
  ordinal: number;
  value: ContentReference;
};
function bad(): never {
  throw new ProtocolError("corrupt_storage", "Invalid ordered map state");
}
function key(value: unknown): OrderedMapKey {
  if (typeof value === "string" && value.length <= 4096) return value;
  if (typeof value === "number" && Number.isFinite(value))
    return value === 0 ? 0 : value;
  throw new RangeError(
    "Ordered map requires a finite number or at most 4096 UTF-16 key units",
  );
}
function reference(value: unknown): ContentReference {
  const result = snapshotContentReferenceSchema.safeParse(value);
  if (!result.success) bad();
  return result.data;
}
function equal(a: ContentReference, b: ContentReference) {
  return a.hash === b.hash && a.byteSize === b.byteSize && a.units === b.units;
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function ordinal(value: number) {
  return String(value).padStart(16, "0");
}
function copy(input: OrderedMapRoot | null): OrderedMapRoot {
  if (input === null)
    return { version: 1, size: 0, nextOrdinal: 0, byKey: null, byOrder: null };
  if (integer(input?.version) && input.version > 1)
    throw new ProtocolError(
      "version_unsupported",
      "Ordered map version is unsupported",
    );
  if (
    !input ||
    Object.keys(input).sort().join(",") !==
      "byKey,byOrder,nextOrdinal,size,version" ||
    input.version !== 1 ||
    !integer(input.size) ||
    !integer(input.nextOrdinal) ||
    input.size > input.nextOrdinal
  )
    bad();
  const byKey = input.byKey === null ? null : copyIndexRoot(input.byKey);
  const byOrder = input.byOrder === null ? null : copyIndexRoot(input.byOrder);
  if (
    (byKey?.count ?? 0) !== input.size ||
    (byOrder?.count ?? 0) !== input.size
  )
    bad();
  if (
    byKey &&
    (!/^[a-f0-9]{64}$/.test(byKey.first) || !/^[a-f0-9]{64}$/.test(byKey.last))
  )
    bad();
  if (
    byOrder &&
    (!/^\d{16}$/.test(byOrder.first) ||
      !/^\d{16}$/.test(byOrder.last) ||
      Number(byOrder.last) >= input.nextOrdinal)
  )
    bad();
  return {
    version: 1,
    size: input.size,
    nextOrdinal: input.nextOrdinal,
    byKey,
    byOrder,
  };
}
/** Immutable insertion-order map over durable value references. Publish both index roots together. */
export class OrderedContentMap {
  private readonly index: ContentIndex;
  constructor(private readonly content: SnapshotContent) {
    this.index = new ContentIndex(content);
  }
  private async hash(name: OrderedMapKey, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(name)),
    );
    signal?.throwIfAborted();
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  private async entry(
    ref: ContentReference,
    signal?: AbortSignal,
  ): Promise<Entry> {
    ref = reference(ref);
    if (ref.units > 32768) bad();
    signal?.throwIfAborted();
    const text = await this.content.read(ref, 0, ref.units, signal);
    signal?.throwIfAborted();
    if (text.length !== ref.units) bad();
    let value: Entry;
    try {
      value = JSON.parse(text);
    } catch {
      return bad();
    }
    if (integer(value?.version) && value.version > 1)
      throw new ProtocolError(
        "version_unsupported",
        "Ordered map entry version is unsupported",
      );
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "key,ordinal,value,version" ||
      value.version !== 1 ||
      !integer(value.ordinal)
    )
      bad();
    try {
      value.key = key(value.key);
    } catch {
      return bad();
    }
    value.value = reference(value.value);
    return value;
  }
  private async lookup(
    root: OrderedMapRoot,
    name: OrderedMapKey,
    hash: string,
    signal?: AbortSignal,
  ): Promise<{ ref: ContentReference; entry: Entry } | undefined> {
    const ref = await this.index.get(root.byKey, hash, signal);
    if (!ref) return undefined;
    const entry = await this.entry(ref, signal);
    if (entry.key !== name || entry.ordinal >= root.nextOrdinal) bad();
    const ordered = await this.index.get(
      root.byOrder,
      ordinal(entry.ordinal),
      signal,
    );
    if (!ordered || !equal(ordered, ref)) bad();
    return { ref, entry };
  }
  async get(
    input: OrderedMapRoot | null,
    name: OrderedMapKey,
    signal?: AbortSignal,
  ): Promise<ContentReference | undefined> {
    const root = copy(input);
    name = key(name);
    const found = await this.lookup(
      root,
      name,
      await this.hash(name, signal),
      signal,
    );
    signal?.throwIfAborted();
    return found?.entry.value;
  }
  async entries(
    input: OrderedMapRoot | null,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<[OrderedMapKey, ContentReference]>> {
    const root = copy(input),
      selected = await this.index.entries(root.byOrder, offset, limit, signal);
    const result: Array<[OrderedMapKey, ContentReference]> = [];
    for (const [position, ref] of selected) {
      const entry = await this.entry(ref, signal);
      if (
        entry.ordinal >= root.nextOrdinal ||
        ordinal(entry.ordinal) !== position
      )
        bad();
      const keyed = await this.index.get(
        root.byKey,
        await this.hash(entry.key, signal),
        signal,
      );
      if (!keyed || !equal(keyed, ref)) bad();
      result.push([entry.key, entry.value]);
    }
    signal?.throwIfAborted();
    return result;
  }
  async set(
    input: OrderedMapRoot | null,
    name: OrderedMapKey,
    value: ContentReference,
    signal?: AbortSignal,
  ): Promise<OrderedMapRoot> {
    const root = copy(input);
    name = key(name);
    value = reference(value);
    const hash = await this.hash(name, signal),
      previous = await this.lookup(root, name, hash, signal);
    signal?.throwIfAborted();
    if (previous && equal(previous.entry.value, value)) return root;
    if (!previous && root.nextOrdinal === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Ordered map ordinal capacity exceeded");
    const position = previous?.entry.ordinal ?? root.nextOrdinal;
    const text = canonicalJson({
      version: 1,
      key: name,
      ordinal: position,
      value,
    } satisfies Entry);
    if (text.length > 32768)
      throw new RangeError("Ordered map entry exceeds capacity");
    const ref = reference(await this.content.put(text, signal));
    signal?.throwIfAborted();
    if (ref.units !== text.length) bad();
    const byKey = await this.index.set(root.byKey, hash, ref, signal);
    const byOrder = await this.index.set(
      root.byOrder,
      ordinal(position),
      ref,
      signal,
    );
    signal?.throwIfAborted();
    return {
      version: 1,
      size: root.size + (previous ? 0 : 1),
      nextOrdinal: root.nextOrdinal + (previous ? 0 : 1),
      byKey,
      byOrder,
    };
  }
  async delete(
    input: OrderedMapRoot | null,
    name: OrderedMapKey,
    signal?: AbortSignal,
  ): Promise<OrderedMapRoot> {
    const root = copy(input);
    name = key(name);
    const hash = await this.hash(name, signal),
      previous = await this.lookup(root, name, hash, signal);
    signal?.throwIfAborted();
    if (!previous) return root;
    const byKey = await this.index.delete(root.byKey, hash, signal);
    const byOrder = await this.index.delete(
      root.byOrder,
      ordinal(previous.entry.ordinal),
      signal,
    );
    signal?.throwIfAborted();
    return {
      version: 1,
      size: root.size - 1,
      nextOrdinal: root.nextOrdinal,
      byKey,
      byOrder,
    };
  }
}
