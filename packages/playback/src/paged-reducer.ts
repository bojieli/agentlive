import {
  canonicalJson,
  contentSchema,
  reduceCompletenessNotice,
  reducedCompletenessNoticeSchema,
  type ReducedCompletenessNotice,
  attachmentSchema,
  storedEventSchema,
  idSchema,
  ProtocolError,
  parseContentReference,
  type StoredEvent,
  type EventContent,
} from "@agentlive/protocol";
import {
  OrderedContentMap,
  copyOrderedMapRoot,
  type OrderedMapRoot,
  type OrderedMapKey,
} from "./ordered-map.js";
import type {
  ContentReference,
  SnapshotContent,
  SnapshotBinding,
} from "./snapshot.js";
import {
  initialState,
  type RecordingState,
  type Message,
  type Tool,
} from "./index.js";
export interface PagedContent extends SnapshotContent {
  append(
    ref: ContentReference,
    source: string,
    signal?: AbortSignal,
  ): Promise<ContentReference>;
}
const names = [
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
  "gaps",
] as const;
type Name = (typeof names)[number];
type PlainName =
  | "agents"
  | "tasks"
  | "monitors"
  | "goals"
  | "interactions"
  | "plans"
  | "references";
type ValueOf<T> = T extends Map<unknown, infer V> ? V : never;
type Items = { [K in PlainName]: ValueOf<RecordingState[K]> } & {
  messages: Omit<Message, "text"> & { text: ContentReference };
  tools: Omit<Tool, "input" | "output"> & {
    input: ContentReference;
    output: ContentReference;
  };
  changes: { path: string; patch: ContentReference; applied: boolean };
  artifacts: Omit<ValueOf<RecordingState["artifacts"]>, "versions"> & {
    versions: OrderedMapRoot | null;
  };
  replacements: {
    target: "message" | "tool.input" | "tool.output" | "change.patch";
    targetId: string;
    chunks: OrderedMapRoot | null;
    text: ContentReference;
    length: number;
  };
  gaps: RecordingState["gaps"][number];
};
export type PagedItem<K extends Name> = Items[K];
export interface PagedRecordingState {
  version: 1;
  appliedSeq: number;
  timelineMs: number;
  title: string;
  lifecycle: "open" | "ended";
  maps: Record<Name, OrderedMapRoot | null>;
  /** Optional so roots without a notice keep their original canonical bytes. */
  completeness?: ReducedCompletenessNotice;
}
function bad(): never {
  throw new ProtocolError("corrupt_storage", "Invalid paged reducer state");
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function ref(value: unknown): ContentReference {
  return parseContentReference(value) ?? bad();
}
function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    bad();
}
function copy(state: PagedRecordingState): PagedRecordingState {
  if (
    !state ||
    state.version !== 1 ||
    !integer(state.appliedSeq) ||
    !Number.isFinite(state.timelineMs) ||
    state.timelineMs < 0 ||
    typeof state.title !== "string" ||
    state.title.length > 4096 ||
    !["open", "ended"].includes(state.lifecycle)
  )
    bad();
  fields(
    state as unknown as Record<string, unknown>,
    ["version", "appliedSeq", "timelineMs", "title", "lifecycle", "maps"],
    ["completeness"],
  );
  let completeness: ReducedCompletenessNotice | undefined;
  if (state.completeness !== undefined) {
    const parsed = reducedCompletenessNoticeSchema.safeParse(
      state.completeness,
    );
    if (!parsed.success || parsed.data.at > state.appliedSeq) bad();
    completeness = parsed.data;
  }
  if (
    !state.maps ||
    Object.keys(state.maps).sort().join(",") !== [...names].sort().join(",")
  )
    bad();
  const maps = Object.fromEntries(
    names.map((name) => [
      name,
      state.maps[name] === null ? null : copyOrderedMapRoot(state.maps[name]),
    ]),
  ) as PagedRecordingState["maps"];
  if ((maps.replacements?.size ?? 0) > 16) bad();
  return {
    version: 1,
    appliedSeq: state.appliedSeq,
    timelineMs: state.timelineMs,
    title: state.title,
    lifecycle: state.lifecycle,
    maps,
    ...(completeness ? { completeness } : {}),
  };
}
export function initialPagedState(): PagedRecordingState {
  return {
    version: 1,
    appliedSeq: 0,
    timelineMs: 0,
    title: "",
    lifecycle: "open",
    maps: Object.fromEntries(
      names.map((name) => [name, null]),
    ) as PagedRecordingState["maps"],
  };
}
/** Async event reducer: load affected objects only, retain text and maps as immutable references. */
export class PagedReducer {
  private readonly map: OrderedContentMap;
  constructor(private readonly content: PagedContent) {
    this.map = new OrderedContentMap(content);
  }
  private async json(
    reference: ContentReference,
    signal?: AbortSignal,
  ): Promise<unknown> {
    reference = ref(reference);
    if (reference.units > 2 * 1024 * 1024) bad();
    let text = "";
    for (let offset = 0; offset < reference.units; offset += 65536) {
      signal?.throwIfAborted();
      const length = Math.min(65536, reference.units - offset);
      const part = await this.content.read(reference, offset, length, signal);
      if (part.length !== length) bad();
      text += part;
    }
    signal?.throwIfAborted();
    try {
      return JSON.parse(text);
    } catch {
      return bad();
    }
  }
  private async save(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ContentReference> {
    const text = canonicalJson(value);
    if (text.length > 2 * 1024 * 1024)
      throw new RangeError("Paged object exceeds metadata limit");
    const result = ref(await this.content.put(text, signal));
    signal?.throwIfAborted();
    if (result.units !== text.length) bad();
    return result;
  }
  private validate<K extends Name>(name: K, raw: unknown): Items[K] {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
    const value = raw as Record<string, unknown>;
    const plain: Partial<Record<Name, EventContent["kind"]>> = {
      agents: "agent.updated",
      tasks: "task.updated",
      monitors: "monitor.updated",
      goals: "goal.updated",
      interactions: "interaction.updated",
      plans: "plan.updated",
    };
    if (plain[name]) {
      if (
        !contentSchema.safeParse({ kind: plain[name], payload: value }).success
      )
        bad();
      return raw as Items[K];
    }
    if (name === "messages" || name === "tools") {
      fields(
        value,
        name === "messages"
          ? ["id", "role", "text", "completed"]
          : ["id", "name", "input", "output", "status"],
        ["visible", "agentId"],
      );
      if (
        !idSchema.safeParse(value.id).success ||
        (value.agentId !== undefined &&
          !idSchema.safeParse(value.agentId).success) ||
        (value.visible !== undefined && typeof value.visible !== "boolean")
      )
        bad();
      if (name === "messages") {
        if (
          !["user", "assistant", "system"].includes(value.role as string) ||
          typeof value.completed !== "boolean"
        )
          bad();
        value.text = ref(value.text);
      } else {
        if (
          typeof value.name !== "string" ||
          !["running", "completed", "failed", "interrupted"].includes(
            value.status as string,
          )
        )
          bad();
        value.input = ref(value.input);
        value.output = ref(value.output);
      }
    } else if (name === "changes") {
      fields(value, ["path", "patch", "applied"]);
      if (typeof value.path !== "string" || typeof value.applied !== "boolean")
        bad();
      value.patch = ref(value.patch);
    } else if (name === "artifacts") {
      fields(value, ["filename", "pending", "versions"], ["visible", "reason"]);
      if (
        typeof value.filename !== "string" ||
        typeof value.pending !== "boolean" ||
        (value.visible !== undefined && typeof value.visible !== "boolean") ||
        (value.reason !== undefined && typeof value.reason !== "string")
      )
        bad();
      value.versions =
        value.versions === null
          ? null
          : copyOrderedMapRoot(value.versions as OrderedMapRoot);
    } else if (name === "replacements") {
      fields(value, ["target", "targetId", "chunks", "text", "length"]);
      if (
        !["message", "tool.input", "tool.output", "change.patch"].includes(
          value.target as string,
        ) ||
        !idSchema.safeParse(value.targetId).success ||
        !integer(value.length) ||
        value.length > 32 * 1024 * 1024
      )
        bad();
      value.text = ref(value.text);
      if ((value.text as ContentReference).units !== value.length) bad();
      value.chunks =
        value.chunks === null
          ? null
          : copyOrderedMapRoot(value.chunks as OrderedMapRoot);
    } else if (name === "references") {
      fields(value, ["artifactId", "version"]);
      if (
        !idSchema.safeParse(value.artifactId).success ||
        !integer(value.version) ||
        value.version < 1
      )
        bad();
    } else if (name === "gaps") {
      fields(value, ["at", "reason", "recoveredState"]);
      if (
        !integer(value.at) ||
        typeof value.reason !== "string" ||
        typeof value.recoveredState !== "boolean"
      )
        bad();
    }
    return value as Items[K];
  }
  private checkKey(
    name: Name,
    key: OrderedMapKey,
    item: unknown,
    through: number,
  ) {
    const value = item as Record<string, unknown>;
    if (name === "gaps") {
      if (
        typeof key !== "number" ||
        key < 1 ||
        value.at !== key ||
        key > through
      )
        bad();
      return;
    }
    if (typeof key !== "string") bad();
    const idField: Partial<Record<Name, string>> = {
      messages: "id",
      tools: "id",
      agents: "agentId",
      tasks: "taskId",
      monitors: "monitorId",
      goals: "goalId",
      interactions: "interactionId",
      plans: "planId",
    };
    if (idField[name] && value[idField[name]!] !== key) bad();
    if (name !== "references" && !idSchema.safeParse(key).success) bad();
  }
  private async mapKey(name: Name, key: OrderedMapKey, signal?: AbortSignal) {
    if (name !== "references") return key;
    if (typeof key !== "string" || key.length > 1024 * 1024) bad();
    signal?.throwIfAborted();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    signal?.throwIfAborted();
    return (
      "reference-" +
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")
    );
  }
  private async readItem<K extends Name>(
    name: K,
    storedKey: OrderedMapKey,
    reference: ContentReference,
    through: number,
    signal?: AbortSignal,
  ): Promise<[OrderedMapKey, Items[K]]> {
    const raw = await this.json(reference, signal);
    if (name === "references") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
      const { sourceKey, ...value } = raw as Record<string, unknown>;
      if (
        typeof sourceKey !== "string" ||
        (await this.mapKey(name, sourceKey, signal)) !== storedKey
      )
        bad();
      return [sourceKey, this.validate(name, value)];
    }
    const item = this.validate(name, raw);
    this.checkKey(name, storedKey, item, through);
    return [storedKey, item];
  }
  async get<K extends Name>(
    state: PagedRecordingState,
    name: K,
    key: OrderedMapKey,
    signal?: AbortSignal,
  ): Promise<Items[K] | undefined> {
    const root = copy(state),
      reference = await this.map.get(
        root.maps[name],
        await this.mapKey(name, key, signal),
        signal,
      );
    if (!reference) {
      signal?.throwIfAborted();
      return undefined;
    }
    const [actualKey, item] = await this.readItem(
      name,
      await this.mapKey(name, key, signal),
      reference,
      root.appliedSeq,
      signal,
    );
    if (actualKey !== key) bad();
    return item;
  }
  async entries<K extends Name>(
    state: PagedRecordingState,
    name: K,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<[OrderedMapKey, Items[K]]>> {
    const root = copy(state),
      result: Array<[OrderedMapKey, Items[K]]> = [];
    for (const [key, reference] of await this.map.entries(
      root.maps[name],
      offset,
      limit,
      signal,
    )) {
      result.push(
        await this.readItem(name, key, reference, root.appliedSeq, signal),
      );
    }
    signal?.throwIfAborted();
    return result;
  }
  private async readAttachment(
    artifactId: string,
    version: OrderedMapKey,
    reference: ContentReference,
    signal?: AbortSignal,
  ) {
    const parsed = attachmentSchema.safeParse(
      await this.json(reference, signal),
    );
    if (
      !parsed.success ||
      parsed.data.artifactId !== artifactId ||
      parsed.data.version !== version
    )
      bad();
    return parsed.data;
  }
  async artifactVersion(
    state: PagedRecordingState,
    artifactId: string,
    version: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new RangeError("Invalid artifact version");
    const artifact = await this.get(state, "artifacts", artifactId, signal);
    const reference = await this.map.get(
      artifact?.versions ?? null,
      version,
      signal,
    );
    return reference
      ? this.readAttachment(artifactId, version, reference, signal)
      : undefined;
  }
  async artifactVersions(
    state: PagedRecordingState,
    artifactId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    const artifact = await this.get(state, "artifacts", artifactId, signal),
      result = [];
    for (const [version, reference] of await this.map.entries(
      artifact?.versions ?? null,
      offset,
      limit,
      signal,
    ))
      result.push(
        await this.readAttachment(artifactId, version, reference, signal),
      );
    return result;
  }
  /** Reduce a bounded checkpoint batch without persisting unobserved intermediate text roots.
   * Every original event is validated; only adjacent appends of the same field/object coalesce.
   * The optional observer receives each completed group, not fabricated stored events.
   */
  async applyBatch(
    input: PagedRecordingState,
    raw: readonly StoredEvent[],
    signal?: AbortSignal,
    reduced?: (
      state: PagedRecordingState,
      events: readonly StoredEvent[],
    ) => Promise<void>,
  ): Promise<PagedRecordingState> {
    if (raw.length > 256)
      throw new RangeError("Paged batch exceeds event limit");
    const encoded = canonicalJson(raw);
    if (new TextEncoder().encode(encoded).length > 1048576)
      throw new RangeError("Paged batch exceeds byte limit");
    const events = (JSON.parse(encoded) as unknown[]).map((event) =>
      storedEventSchema.parse(event),
    );
    let state = copy(input),
      sequence = state.appliedSeq,
      time = state.timelineMs;
    for (const event of events) {
      signal?.throwIfAborted();
      if (event.serverSeq !== ++sequence)
        throw new ProtocolError(
          "sequence_gap",
          "Paged batch is not contiguous",
        );
      if (event.timelineMs < time)
        throw new ProtocolError(
          "event_conflict",
          "Batch timeline moved backward",
        );
      time = event.timelineMs;
    }
    const target = (event: StoredEvent) => {
      const c = event.content;
      return c.kind === "message.text.append"
        ? [c.kind, c.payload.messageId].join("/")
        : c.kind === "tool.arguments.append" || c.kind === "tool.output.append"
          ? [c.kind, c.payload.toolId].join("/")
          : undefined;
    };
    for (let offset = 0; offset < events.length;) {
      const first = events[offset]!,
        key = target(first);
      let end = offset + 1;
      if (key !== undefined)
        while (end < events.length && target(events[end]!) === key) end++;
      const group = events.slice(offset, end);
      if (group.length === 1) state = await this.apply(state, first, signal);
      else {
        const last = group[group.length - 1]!;
        const content = last.content;
        if (
          content.kind !== "message.text.append" &&
          content.kind !== "tool.arguments.append" &&
          content.kind !== "tool.output.append"
        )
          throw new Error("Invalid append group");
        const text = group
          .map((event) => (event.content.payload as { text: string }).text)
          .join("");
        // The checked group is one derivative transition. No intermediate cursor is published.
        state = await this.apply(
          { ...state, appliedSeq: last.serverSeq - 1 },
          {
            ...last,
            content: contentSchema.parse({
              ...content,
              payload: { ...content.payload, text },
            }),
          },
          signal,
        );
      }
      await reduced?.(copy(state), group);
      signal?.throwIfAborted();
      offset = end;
    }
    return state;
  }
  async apply(
    input: PagedRecordingState,
    raw: StoredEvent,
    signal?: AbortSignal,
  ): Promise<PagedRecordingState> {
    const state = copy(input),
      encoded = canonicalJson(raw);
    if (new TextEncoder().encode(encoded).length > 1024 * 1024)
      throw new RangeError("Paged event exceeds protocol limit");
    const event = storedEventSchema.parse(JSON.parse(encoded)),
      content = event.content;
    if (event.serverSeq !== state.appliedSeq + 1)
      throw new ProtocolError(
        "sequence_gap",
        "Reducer requires the next contiguous event",
      );
    if (event.timelineMs < state.timelineMs)
      throw new ProtocolError("event_conflict", "Timeline moved backward");
    signal?.throwIfAborted();
    const require = async <K extends Name>(
      name: K,
      key: OrderedMapKey,
    ): Promise<Items[K]> => {
      const value = await this.get(state, name, key, signal);
      if (!value)
        throw new ProtocolError(
          "sequence_gap",
          `Missing lifecycle start for ${key}`,
        );
      return value;
    };
    const put = async <K extends Name>(
      name: K,
      key: OrderedMapKey,
      value: Items[K],
    ) => {
      state.maps[name] = await this.map.set(
        state.maps[name],
        await this.mapKey(name, key, signal),
        await this.save(
          name === "references" ? { ...value, sourceKey: key } : value,
          signal,
        ),
        signal,
      );
    };
    const text = async (value: string) => {
      const result = ref(await this.content.put(value, signal));
      signal?.throwIfAborted();
      if (result.units !== value.length) bad();
      return result;
    };
    const append = async (base: ContentReference, value: string) => {
      const result = ref(await this.content.append(base, value, signal));
      signal?.throwIfAborted();
      if (result.units !== base.units + value.length) bad();
      return result;
    };
    const available = async (artifactId: string, version: number) => {
      const artifact = await this.get(state, "artifacts", artifactId, signal);
      return (
        !!artifact && !!(await this.map.get(artifact.versions, version, signal))
      );
    };
    switch (content.kind) {
      case "recording.created":
      case "session.started":
        state.title = content.payload.title;
        break;
      case "recording.ended":
        state.lifecycle = "ended";
        break;
      case "recording.reopened":
        state.lifecycle = "open";
        delete state.completeness;
        break;
      case "agent.updated":
        await put("agents", content.payload.agentId, content.payload);
        break;
      case "task.updated":
        await put("tasks", content.payload.taskId, content.payload);
        break;
      case "monitor.updated":
        await put("monitors", content.payload.monitorId, content.payload);
        break;
      case "goal.updated":
        await put("goals", content.payload.goalId, content.payload);
        break;
      case "interaction.updated":
        await put(
          "interactions",
          content.payload.interactionId,
          content.payload,
        );
        break;
      case "plan.updated":
        if (
          content.payload.attachment &&
          !(await available(
            content.payload.attachment.artifactId,
            content.payload.attachment.version,
          ))
        )
          throw new ProtocolError(
            "sequence_gap",
            "Plan attachment version is unavailable",
          );
        await put("plans", content.payload.planId, content.payload);
        break;
      case "object.visibility": {
        const { objectType, objectId, visible } = content.payload;
        if (objectType === "message")
          await put("messages", objectId, {
            ...(await require("messages", objectId)),
            visible,
          });
        else if (objectType === "tool")
          await put("tools", objectId, {
            ...(await require("tools", objectId)),
            visible,
          });
        else
          await put("artifacts", objectId, {
            ...(await require("artifacts", objectId)),
            visible,
          });
        break;
      }
      case "message.started": {
        const p = content.payload;
        if (await this.map.get(state.maps.messages, p.messageId, signal))
          throw new ProtocolError("event_conflict", "Message already started");
        await put("messages", p.messageId, {
          id: p.messageId,
          visible: true,
          role: p.role,
          ...(p.agentId ? { agentId: p.agentId } : {}),
          text: await text(""),
          completed: false,
        });
        break;
      }
      case "message.reopened": {
        const current = await require("messages", content.payload.messageId);
        if (!current.completed)
          throw new ProtocolError(
            "event_conflict",
            "Message is already active",
          );
        await put("messages", current.id, { ...current, completed: false });
        break;
      }
      case "message.text.append":
      case "message.reconciled":
      case "message.completed": {
        const current = await require("messages", content.payload.messageId);
        if (content.kind === "message.text.append" && current.completed)
          throw new ProtocolError(
            "event_conflict",
            "Append after message completion",
          );
        await put("messages", current.id, {
          ...current,
          text:
            content.kind === "message.text.append"
              ? await append(current.text, content.payload.text)
              : content.kind === "message.reconciled"
                ? await text(content.payload.text)
                : current.text,
          completed: current.completed || content.kind === "message.completed",
        });
        break;
      }
      case "tool.started": {
        const p = content.payload;
        if (await this.map.get(state.maps.tools, p.toolId, signal))
          throw new ProtocolError("event_conflict", "Tool already started");
        await put("tools", p.toolId, {
          id: p.toolId,
          visible: true,
          name: p.name,
          ...(p.agentId ? { agentId: p.agentId } : {}),
          input: await text(p.input),
          output: await text(""),
          status: "running",
        });
        break;
      }
      case "tool.reopened": {
        const current = await require("tools", content.payload.toolId);
        if (current.status === "running")
          throw new ProtocolError("event_conflict", "Tool is already active");
        await put("tools", current.id, {
          ...current,
          status: "running",
          output: await text(""),
        });
        break;
      }
      case "tool.arguments.append":
      case "tool.arguments.ready":
      case "tool.output.append":
      case "tool.completed": {
        const current = await require("tools", content.payload.toolId);
        if (content.kind === "tool.arguments.append")
          current.input = await append(current.input, content.payload.text);
        if (content.kind === "tool.arguments.ready")
          current.input = await text(content.payload.input);
        if (content.kind === "tool.output.append")
          current.output = await append(current.output, content.payload.text);
        if (content.kind === "tool.completed") {
          current.status = content.payload.status;
          if (content.payload.output !== undefined)
            current.output = await text(content.payload.output);
        }
        await put("tools", current.id, current);
        break;
      }
      case "file.change.proposed":
      case "file.change.applied":
        await put("changes", content.payload.changeId, {
          path: content.payload.path,
          patch: await text(content.payload.patch),
          applied: content.kind === "file.change.applied",
        });
        break;
      case "attachment.pending": {
        const p = content.payload,
          old = await this.get(state, "artifacts", p.artifactId, signal);
        await put("artifacts", p.artifactId, {
          filename: p.filename,
          visible: old?.visible ?? true,
          pending: true,
          versions: old?.versions ?? null,
        });
        break;
      }
      case "attachment.available": {
        const p = content.payload.attachment,
          old = await this.get(state, "artifacts", p.artifactId, signal);
        if (old && (await this.map.get(old.versions, p.version, signal)))
          throw new ProtocolError(
            "event_conflict",
            "Artifact version already exists",
          );
        const versions = await this.map.set(
          old?.versions ?? null,
          p.version,
          await this.save(p, signal),
          signal,
        );
        await put("artifacts", p.artifactId, {
          filename: p.filename,
          visible: old?.visible ?? true,
          pending: false,
          versions,
        });
        break;
      }
      case "attachment.unavailable": {
        const p = content.payload,
          old = await this.get(state, "artifacts", p.artifactId, signal);
        await put("artifacts", p.artifactId, {
          filename: old?.filename ?? p.artifactId,
          visible: old?.visible ?? true,
          pending: false,
          reason: p.reason,
          versions: old?.versions ?? null,
        });
        break;
      }
      case "reference.resolved": {
        const p = content.payload;
        if (!(await available(p.artifactId, p.version)))
          throw new ProtocolError(
            "sequence_gap",
            "Artifact version is unavailable",
          );
        await put(
          "references",
          JSON.stringify([p.messageId, p.sourceReference]),
          { artifactId: p.artifactId, version: p.version },
        );
        break;
      }
      case "text.replacement.started": {
        const p = content.payload;
        if (
          (state.maps.replacements?.size ?? 0) >= 16 ||
          (await this.map.get(state.maps.replacements, p.replacementId, signal))
        )
          throw new ProtocolError(
            "event_conflict",
            "Invalid or excessive text replacements",
          );
        await require(p.target === "message"
          ? "messages"
          : p.target === "change.patch"
            ? "changes"
            : "tools", p.targetId);
        await put("replacements", p.replacementId, {
          target: p.target,
          targetId: p.targetId,
          chunks: null,
          text: await text(""),
          length: 0,
        });
        break;
      }
      case "text.replacement.chunk": {
        const p = content.payload,
          current = await require("replacements", p.replacementId);
        let total = 0;
        for (const [, replacement] of await this.entries(
          state,
          "replacements",
          0,
          16,
          signal,
        ))
          total += replacement.length;
        if (
          p.index !== (current.chunks?.size ?? 0) ||
          total + p.text.length > 32 * 1024 * 1024
        )
          throw new ProtocolError(
            "sequence_gap",
            "Invalid text replacement chunk or capacity exceeded",
          );
        current.chunks = await this.map.set(
          current.chunks,
          p.index,
          await text(p.text),
          signal,
        );
        current.text = await append(current.text, p.text);
        current.length += p.text.length;
        await put("replacements", p.replacementId, current);
        break;
      }
      case "text.replacement.completed": {
        const p = content.payload,
          current = await require("replacements", p.replacementId);
        if (p.parts !== (current.chunks?.size ?? 0))
          throw new ProtocolError(
            "sequence_gap",
            "Text replacement is incomplete",
          );
        if (current.target === "message")
          await put("messages", current.targetId, {
            ...(await require("messages", current.targetId)),
            text: current.text,
          });
        else if (current.target === "change.patch")
          await put("changes", current.targetId, {
            ...(await require("changes", current.targetId)),
            patch: current.text,
          });
        else
          await put("tools", current.targetId, {
            ...(await require("tools", current.targetId)),
            [current.target === "tool.input" ? "input" : "output"]:
              current.text,
          });
        state.maps.replacements = await this.map.delete(
          state.maps.replacements,
          p.replacementId,
          signal,
        );
        break;
      }
      case "capture.gap":
        await put("gaps", event.serverSeq, {
          at: event.serverSeq,
          ...content.payload,
        });
        break;
      case "capture.completeness":
        state.completeness = reduceCompletenessNotice(
          state.completeness,
          event,
        )!;
        break;
      case "session.ended":
      case "turn.started":
      case "turn.ended":
      case "capture.clock":
      case "publisher.epoch.changed":
        break;
      default: {
        const exhaustive: never = content;
        throw new Error(`Unsupported content ${exhaustive}`);
      }
    }
    signal?.throwIfAborted();
    return {
      ...state,
      appliedSeq: event.serverSeq,
      timelineMs: event.timelineMs,
    };
  }
  /** Trace schema-defined content dependencies from a bound checkpoint.
   * Text and attachment bodies are opaque: attachment hashes are not content-store refs.
   * Callbacks are provisional until success. Caller owns pins and codec-page tracing.
   *
   * Optional `reuse(ref, scope)` lets a collector skip subtrees whose complete
   * dependencies it already retains (see OrderedContentMap.trace). Scopes name
   * the schema position, so equal bytes reached under different item types are
   * traced independently. Aggregate replacement checks run only when no part of
   * that replacement's chunk map was skipped.
   */
  async trace(
    reference: ContentReference,
    binding: SnapshotBinding,
    visit: (reference: ContentReference) => Promise<void>,
    signal?: AbortSignal,
    reuse?: (reference: ContentReference, scope: string) => boolean,
  ): Promise<void> {
    reference = ref(reference);
    const state = await this.open(reference, binding, signal);
    const emit = async (reference: ContentReference) => {
      signal?.throwIfAborted();
      await visit({ ...reference });
      signal?.throwIfAborted();
    };
    if (reuse?.({ ...reference }, "root")) return;
    await emit(reference);
    for (const name of names) {
      await this.map.trace(
        state.maps[name],
        async (entry) => {
          if (entry.kind !== "value") {
            await emit(entry.ref);
            return;
          }
          const [key, item] = await this.readItem(
            name,
            entry.key,
            entry.ref,
            state.appliedSeq,
            signal,
          );
          await emit(entry.ref);
          if (name === "messages") await emit((item as Items["messages"]).text);
          else if (name === "tools") {
            const tool = item as Items["tools"];
            await emit(tool.input);
            await emit(tool.output);
          } else if (name === "changes")
            await emit((item as Items["changes"]).patch);
          else if (name === "artifacts") {
            await this.map.trace(
              (item as Items["artifacts"]).versions,
              async (version) => {
                if (version.kind === "value")
                  await this.readAttachment(
                    String(key),
                    version.key,
                    version.ref,
                    signal,
                  );
                await emit(version.ref);
              },
              signal,
              reuse &&
                ((ref, part) =>
                  reuse(ref, `artifacts/${canonicalJson(key)}/${part}`)),
            );
          } else if (name === "replacements") {
            const replacement = item as Items["replacements"];
            await emit(replacement.text);
            let chunks = 0,
              units = 0,
              partial = false;
            await this.map.trace(
              replacement.chunks,
              async (chunk) => {
                if (chunk.kind === "value") {
                  // Skipped entries leave gaps, but visited keys stay ordered.
                  if (
                    typeof chunk.key !== "number" ||
                    (partial ? chunk.key < chunks : chunk.key !== chunks)
                  )
                    bad();
                  chunks = chunk.key + 1;
                  units += chunk.ref.units;
                  if (
                    !Number.isSafeInteger(units) ||
                    units > replacement.length
                  )
                    bad();
                }
                await emit(chunk.ref);
              },
              signal,
              reuse &&
                ((ref, part) => {
                  const skipped = reuse(
                    ref,
                    `replacements/${canonicalJson(key)}/${part}`,
                  );
                  partial ||= skipped;
                  return skipped;
                }),
            );
            if (!partial && units !== replacement.length) bad();
          }
        },
        signal,
        reuse && ((ref, part) => reuse(ref, `${name}/${part}`)),
      );
    }
    signal?.throwIfAborted();
  }
  async checkpoint(
    state: PagedRecordingState,
    binding: SnapshotBinding,
    signal?: AbortSignal,
  ): Promise<ContentReference> {
    const saved = copy(state),
      streamId = idSchema.parse(binding.streamId),
      revision = idSchema.parse(binding.revision);
    return this.save(
      {
        format: "agentlive.paged-state",
        version: 1,
        reducerVersion: 1,
        streamId,
        revision,
        state: saved,
      },
      signal,
    );
  }
  async open(
    reference: ContentReference,
    binding: SnapshotBinding,
    signal?: AbortSignal,
  ): Promise<PagedRecordingState> {
    const streamId = idSchema.parse(binding.streamId),
      revision = idSchema.parse(binding.revision);
    const raw = (await this.json(reference, signal)) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") bad();
    fields(raw, [
      "format",
      "version",
      "reducerVersion",
      "streamId",
      "revision",
      "state",
    ]);
    if (
      (integer(raw.version) && raw.version > 1) ||
      (integer(raw.reducerVersion) && raw.reducerVersion > 1)
    )
      throw new ProtocolError(
        "version_unsupported",
        "Paged reducer checkpoint version is unsupported",
      );
    if (
      raw.format !== "agentlive.paged-state" ||
      raw.version !== 1 ||
      raw.reducerVersion !== 1
    )
      bad();
    if (raw.streamId !== streamId || raw.revision !== revision)
      throw new ProtocolError(
        "revision_changed",
        "Paged reducer checkpoint binding changed",
      );
    return copy(raw.state as PagedRecordingState);
  }
  /** Bounded equivalence helper; production views read object and text ranges. */
  async materialize(
    input: PagedRecordingState,
    maxUnits = 16 * 1024 * 1024,
    signal?: AbortSignal,
  ): Promise<RecordingState> {
    const state = copy(input),
      output = initialState();
    if (!integer(maxUnits) || !maxUnits)
      throw new RangeError("Invalid materialization budget");
    let units = 0;
    const charge = (count: number) => {
      units += count;
      if (units > maxUnits)
        throw new RangeError("Paged materialization budget exceeded");
    };
    const text = async (reference: ContentReference) => {
      charge(32 + reference.units);
      if (!reference.units) {
        if ((await this.content.read(reference, 0, 0, signal)) !== "") bad();
      }
      let result = "";
      for (let offset = 0; offset < reference.units; offset += 65536) {
        const length = Math.min(65536, reference.units - offset);
        const part = await this.content.read(reference, offset, length, signal);
        if (part.length !== length) bad();
        result += part;
      }
      return result;
    };
    charge(128 + state.title.length);
    Object.assign(output, {
      appliedSeq: state.appliedSeq,
      timelineMs: state.timelineMs,
      title: state.title,
      lifecycle: state.lifecycle,
      ...(state.completeness ? { completeness: state.completeness } : {}),
    });
    for (const name of names)
      for (let offset = 0; offset < (state.maps[name]?.size ?? 0); offset += 32)
        for (const [key, item] of await this.entries(
          state,
          name,
          offset,
          32,
          signal,
        )) {
          charge(
            64 +
              (typeof key === "string" ? key.length : 8) +
              canonicalJson(item).length,
          );
          let value: unknown = item;
          if (name === "messages") {
            const current = item as Items["messages"];
            value = { ...current, text: await text(current.text) };
          }
          if (name === "tools") {
            const current = item as Items["tools"];
            value = {
              ...current,
              input: await text(current.input),
              output: await text(current.output),
            };
          }
          if (name === "changes") {
            const current = item as Items["changes"];
            value = { ...current, patch: await text(current.patch) };
          }
          if (name === "artifacts") {
            const current = item as Items["artifacts"],
              versions = new Map();
            for (let i = 0; i < (current.versions?.size ?? 0); i += 32)
              for (const [version, reference] of await this.map.entries(
                current.versions,
                i,
                32,
                signal,
              )) {
                const descriptor = await this.json(reference, signal);
                charge(64 + canonicalJson(descriptor).length);
                const valid = contentSchema.safeParse({
                  kind: "attachment.available",
                  payload: { attachment: descriptor },
                });
                if (
                  !valid.success ||
                  valid.data.kind !== "attachment.available" ||
                  valid.data.payload.attachment.version !== version ||
                  valid.data.payload.attachment.artifactId !== key
                )
                  bad();
                versions.set(version, descriptor);
              }
            value = { ...current, versions };
          }
          if (name === "replacements") {
            const current = item as Items["replacements"],
              chunks: string[] = [];
            for (let i = 0; i < (current.chunks?.size ?? 0); i += 32)
              for (const [index, reference] of await this.map.entries(
                current.chunks,
                i,
                32,
                signal,
              )) {
                if (index !== chunks.length) bad();
                chunks.push(await text(reference));
              }
            if (
              chunks.reduce((sum, chunk) => sum + chunk.length, 0) !==
              current.length
            )
              bad();
            value = {
              target: current.target,
              targetId: current.targetId,
              chunks,
              length: current.length,
            };
          }
          if (name === "gaps") output.gaps.push(value as Items["gaps"]);
          else (output[name] as Map<OrderedMapKey, unknown>).set(key, value);
        }
    signal?.throwIfAborted();
    return output;
  }
}
