import {
  canonicalJson,
  ProtocolError,
  idSchema,
  storedEventSchema,
  type StoredEvent,
  snapshotContentReferenceSchema,
} from "@agentlive/protocol";
import {
  ContentIndex,
  copyIndexRoot,
  type IndexRoot,
} from "./content-index.js";
import type {
  SnapshotContent,
  ContentReference,
  SnapshotBinding,
} from "./snapshot.js";
import type { PagedReducer, PagedRecordingState } from "./paged-reducer.js";
const kinds = [
  "messages",
  "tools",
  "changes",
  "artifacts",
  "agents",
  "tasks",
  "goals",
  "interactions",
  "plans",
  "monitors",
] as const;
export type IndexedActivityKind = (typeof kinds)[number] | "gaps";
export interface ActivityIdentity {
  key: string;
  kind: IndexedActivityKind;
  id: string;
}
interface Row extends ActivityIdentity {
  firstSeq: number;
  visible: boolean;
}
export interface ActivityIndexRoot {
  version: 1;
  appliedSeq: number;
  gaps: number;
  seen: IndexRoot | null;
  visible: IndexRoot | null;
}
export function initialActivityIndex(): ActivityIndexRoot {
  return { version: 1, appliedSeq: 0, gaps: 0, seen: null, visible: null };
}
/** Shared first-mention order, including descriptors carried by availability events. */
export function activityMentions(event: StoredEvent): ActivityIdentity[] {
  const payload = event.content.payload as Record<string, unknown>,
    rows = new Map<string, ActivityIdentity>();
  const add = (kind: IndexedActivityKind, id: unknown) => {
    if (typeof id === "string") {
      const key = `${kind}/${id}`;
      rows.set(key, { key, kind, id });
    }
  };
  for (const [kind, field] of [
    ["messages", "messageId"],
    ["tools", "toolId"],
    ["changes", "changeId"],
    ["artifacts", "artifactId"],
    ["agents", "agentId"],
    ["tasks", "taskId"],
    ["goals", "goalId"],
    ["interactions", "interactionId"],
    ["plans", "planId"],
    ["monitors", "monitorId"],
  ] as const)
    add(kind, payload[field]);
  if (event.content.kind === "attachment.available")
    add("artifacts", event.content.payload.attachment.artifactId);
  if (event.content.kind === "object.visibility")
    add(
      event.content.payload.objectType === "message"
        ? "messages"
        : event.content.payload.objectType === "tool"
          ? "tools"
          : "artifacts",
      event.content.payload.objectId,
    );
  return [...rows.values()];
}
function bad(): never {
  throw new ProtocolError("corrupt_storage", "Invalid activity index");
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function copy(root: ActivityIndexRoot): ActivityIndexRoot {
  if (
    !root ||
    Object.keys(root).sort().join(",") !==
      "appliedSeq,gaps,seen,version,visible" ||
    root.version !== 1 ||
    !integer(root.appliedSeq) ||
    !integer(root.gaps) ||
    root.gaps > root.appliedSeq
  )
    bad();
  const seen = root.seen === null ? null : copyIndexRoot(root.seen),
    visible = root.visible === null ? null : copyIndexRoot(root.visible);
  if (
    (visible?.count ?? 0) > (seen?.count ?? 0) ||
    root.gaps > (visible?.count ?? 0)
  )
    bad();
  return { ...root, seen, visible };
}
function order(row: Row) {
  return `${row.kind === "gaps" ? "z" : "a"}/${String(row.firstSeq).padStart(16, "0")}/${String(kinds.indexOf(row.kind as (typeof kinds)[number])).padStart(2, "0")}/${row.id}`;
}
function equal(
  a: ContentReference | undefined,
  b: ContentReference | undefined,
) {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}
export class ActivityIndex {
  private readonly index: ContentIndex;
  constructor(private readonly content: SnapshotContent) {
    this.index = new ContentIndex(content);
  }
  private async json(ref: ContentReference, signal?: AbortSignal) {
    ref = snapshotContentReferenceSchema.parse(ref);
    if (ref.units > 32768) bad();
    const text = await this.content.read(ref, 0, ref.units, signal);
    signal?.throwIfAborted();
    if (text.length !== ref.units) bad();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return bad();
    }
  }
  private async save(value: unknown, signal?: AbortSignal) {
    const text = canonicalJson(value);
    if (text.length > 32768) bad();
    const ref = snapshotContentReferenceSchema.parse(
      await this.content.put(text, signal),
    );
    signal?.throwIfAborted();
    if (ref.units !== text.length) bad();
    return ref;
  }
  private async row(
    reference: ContentReference,
    root: ActivityIndexRoot,
    signal?: AbortSignal,
  ): Promise<Row> {
    const row = (await this.json(reference, signal)) as Row;
    if (
      !row ||
      Object.keys(row).sort().join(",") !== "firstSeq,id,key,kind,visible" ||
      ![...kinds, "gaps"].includes(row.kind) ||
      typeof row.id !== "string" ||
      row.key !== `${row.kind}/${row.id}` ||
      !integer(row.firstSeq) ||
      row.firstSeq < 1 ||
      row.firstSeq > root.appliedSeq ||
      typeof row.visible !== "boolean"
    )
      bad();
    if (row.kind === "gaps") {
      const ordinal = Number(row.id);
      if (
        !integer(ordinal) ||
        String(ordinal) !== row.id ||
        ordinal >= root.gaps ||
        !row.visible
      )
        bad();
    } else if (!idSchema.safeParse(row.id).success) bad();
    return row;
  }
  private async seen(
    root: ActivityIndexRoot,
    key: string,
    signal?: AbortSignal,
  ): Promise<Row | undefined> {
    const reference = await this.index.get(root.seen, key, signal);
    if (!reference) return;
    const row = await this.row(reference, root, signal);
    if (row.key !== key) bad();
    const visible = await this.index.get(root.visible, order(row), signal);
    if (row.visible ? !equal(reference, visible) : visible !== undefined) bad();
    return row;
  }
  /** Append-only reducer groups preserve activity identity, order and visibility. */
  advanceAppends(
    input: ActivityIndexRoot,
    events: readonly StoredEvent[],
    state: PagedRecordingState,
  ): ActivityIndexRoot {
    const root = copy(input);
    if (!events.length || events.length > 256)
      throw new RangeError("Invalid activity append group");
    const encoded = canonicalJson(events);
    if (new TextEncoder().encode(encoded).length > 1048576)
      throw new RangeError("Activity append group exceeds byte limit");
    const validated = (JSON.parse(encoded) as unknown[]).map((event) =>
      storedEventSchema.parse(event),
    );
    for (const event of validated) {
      if (event.serverSeq !== root.appliedSeq + 1)
        throw new ProtocolError(
          "sequence_gap",
          "Activity append group is not contiguous",
        );
      if (
        ![
          "message.text.append",
          "tool.arguments.append",
          "tool.output.append",
        ].includes(event.content.kind)
      )
        throw new ProtocolError(
          "invalid_request",
          "Activity group can only contain text appends",
        );
      root.appliedSeq = event.serverSeq;
    }
    if (
      state.appliedSeq !== root.appliedSeq ||
      (state.maps.gaps?.size ?? 0) !== root.gaps
    )
      throw new ProtocolError(
        "sequence_gap",
        "Activity append group differs from reduced state",
      );
    return root;
  }
  async apply(
    input: ActivityIndexRoot,
    raw: StoredEvent,
    state: PagedRecordingState,
    reducer: PagedReducer,
    signal?: AbortSignal,
  ): Promise<ActivityIndexRoot> {
    const root = copy(input),
      encoded = canonicalJson(raw);
    if (new TextEncoder().encode(encoded).length > 1048576)
      throw new RangeError("Activity event exceeds limit");
    const event = storedEventSchema.parse(JSON.parse(encoded));
    if (
      event.serverSeq !== root.appliedSeq + 1 ||
      state.appliedSeq !== event.serverSeq
    )
      throw new ProtocolError(
        "sequence_gap",
        "Activity index requires the next reduced event",
      );
    signal?.throwIfAborted();
    // These transitions require an existing object and preserve identity and visibility.
    const unchanged = [
      "message.text.append",
      "message.reconciled",
      "message.completed",
      "message.reopened",
      "tool.arguments.append",
      "tool.arguments.ready",
      "tool.output.append",
      "tool.completed",
      "tool.reopened",
    ].includes(event.content.kind);
    const mentions = unchanged ? [] : activityMentions(event);
    if (event.content.kind === "capture.gap")
      mentions.push({
        kind: "gaps",
        id: String(root.gaps),
        key: `gaps/${root.gaps}`,
      });
    for (const mention of mentions) {
      const previous = await this.seen(root, mention.key, signal);
      let visible = true;
      if (mention.kind !== "gaps") {
        const item = await reducer.get(state, mention.kind, mention.id, signal);
        visible = !!item && !("visible" in item && item.visible === false);
      }
      if (previous && previous.visible === visible) continue;
      const row: Row = {
        ...mention,
        firstSeq: previous?.firstSeq ?? event.serverSeq,
        visible,
      };
      const reference = await this.save(row, signal);
      root.seen = await this.index.set(root.seen, row.key, reference, signal);
      root.visible = visible
        ? await this.index.set(root.visible, order(row), reference, signal)
        : await this.index.delete(root.visible, order(row), signal);
    }
    root.appliedSeq = event.serverSeq;
    if (event.content.kind === "capture.gap") root.gaps++;
    if (root.gaps !== (state.maps.gaps?.size ?? 0)) bad();
    signal?.throwIfAborted();
    return root;
  }
  async entries(
    input: ActivityIndexRoot,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ActivityIdentity[]> {
    const root = copy(input),
      rows: ActivityIdentity[] = [];
    for (const [key, reference] of await this.index.entries(
      root.visible,
      offset,
      limit,
      signal,
    )) {
      const row = await this.row(reference, root, signal);
      if (
        !row.visible ||
        key !== order(row) ||
        !equal(reference, await this.index.get(root.seen, row.key, signal))
      )
        bad();
      rows.push({ kind: row.kind, id: row.id, key: row.key });
    }
    signal?.throwIfAborted();
    return rows;
  }
  async position(
    input: ActivityIndexRoot,
    key: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const root = copy(input),
      row = await this.seen(root, key, signal);
    if (!row?.visible) return undefined;
    const position = await this.index.rank(root.visible, order(row), signal);
    if (position === undefined) bad();
    return position;
  }
  /** Trace schema-defined activity dependencies, checking both indexes and complete gap rows.
   * Results are provisional until success; callers own codec tracing and root pins.
   */
  async trace(
    reference: ContentReference,
    binding: SnapshotBinding,
    visit: (reference: ContentReference) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    reference = snapshotContentReferenceSchema.parse(reference);
    binding = { ...binding };
    const root = await this.open(reference, binding, signal);
    const emit = async (ref: ContentReference) => {
      signal?.throwIfAborted();
      await visit({ ...ref });
      signal?.throwIfAborted();
    };
    await emit(reference);
    let gaps = 0;
    await this.index.trace(
      root.seen,
      async (entry) => {
        if (entry.kind === "value") {
          const row = await this.row(entry.ref, root, signal);
          if (row.key !== entry.key) bad();
          const visible = await this.index.get(
            root.visible,
            order(row),
            signal,
          );
          if (row.visible ? !equal(entry.ref, visible) : visible !== undefined)
            bad();
          if (row.kind === "gaps") gaps++;
        }
        await emit(entry.ref);
      },
      signal,
    );
    if (gaps !== root.gaps) bad();
    await this.index.trace(
      root.visible,
      async (entry) => {
        if (entry.kind === "value") {
          const row = await this.row(entry.ref, root, signal);
          if (
            !row.visible ||
            entry.key !== order(row) ||
            !equal(entry.ref, await this.index.get(root.seen, row.key, signal))
          )
            bad();
        }
        await emit(entry.ref);
      },
      signal,
    );
    signal?.throwIfAborted();
  }
  async checkpoint(
    input: ActivityIndexRoot,
    binding: SnapshotBinding,
    signal?: AbortSignal,
  ) {
    return this.save(
      {
        format: "agentlive.activity-index",
        version: 1,
        streamId: idSchema.parse(binding.streamId),
        revision: idSchema.parse(binding.revision),
        root: copy(input),
      },
      signal,
    );
  }
  async open(
    ref: ContentReference,
    binding: SnapshotBinding,
    signal?: AbortSignal,
  ): Promise<ActivityIndexRoot> {
    const value = (await this.json(ref, signal)) as Record<string, unknown>;
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "format,revision,root,streamId,version" ||
      value.format !== "agentlive.activity-index" ||
      value.version !== 1
    )
      bad();
    if (
      value.streamId !== idSchema.parse(binding.streamId) ||
      value.revision !== idSchema.parse(binding.revision)
    )
      throw new ProtocolError(
        "revision_changed",
        "Activity index binding differs",
      );
    return copy(value.root as ActivityIndexRoot);
  }
}
