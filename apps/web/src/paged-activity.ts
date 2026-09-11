import { ProtocolError } from "@agentlive/protocol";
import { objectAnchor } from "./workflow-card.js";
import {
  completenessSummary,
  initialState,
  unfinished,
  type CompletenessSummary,
  type RecordingState,
  type PagedReducer,
  type PagedRecordingState,
  type ContentReference,
  type PagedItem,
  type ActivityIndex,
  type ActivityIndexRoot,
} from "@agentlive/playback";
import type { ActivityRow } from "./activity.js";
import type { TextSource } from "./text-source.js";
export interface LoadedActivity {
  state: RecordingState;
  texts: Partial<Record<"text" | "input" | "output" | "patch", TextSource>>;
  gap?: RecordingState["gaps"][number];
  versions?: { offset: number; total: number };
}
/** Immutable view of one reducer boundary; loads only the selected card and its direct links. */
export class PagedActivityView {
  private readonly root: PagedRecordingState;
  constructor(
    private readonly reducer: PagedReducer,
    root: PagedRecordingState,
    private readonly source: (ref: ContentReference) => TextSource,
    private readonly activity?: {
      index: ActivityIndex;
      root: ActivityIndexRoot;
    },
    private readonly recover?: (signal: AbortSignal) => Promise<void>,
    private readonly release?: () => Promise<void>,
  ) {
    const originalSource = source;
    this.source = (ref) => {
      const text = originalSource(ref);
      return Object.freeze<TextSource>({
        ...text,
        read: (offset, length, signal) =>
          this.readRecovery(() => text.read(offset, length, signal), signal),
      });
    };
    this.root = structuredClone(root);
    if (activity) {
      this.activity = {
        index: activity.index,
        root: structuredClone(activity.root),
      };
      if (activity.root.appliedSeq !== root.appliedSeq)
        throw new ProtocolError(
          "corrupt_storage",
          "Activity view boundaries differ",
        );
    }
  }
  private recovery: Promise<void> | undefined;
  private reads = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  /** Reject new reads, drain admitted reads, then release the presentation pin. */
  close(): Promise<void> {
    if (!this.closing)
      this.closing = Promise.allSettled([...this.reads]).then(() =>
        this.release?.(),
      );
    return this.closing;
  }
  private async readRecovery<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.closing) throw new Error("Activity view is closed");
    const task = this.readOnce(operation, signal);
    this.reads.add(task);
    try {
      return await task;
    } finally {
      this.reads.delete(task);
    }
  }
  private async readOnce<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (
        !this.recover ||
        !(error instanceof ProtocolError) ||
        error.code !== "stale_lease"
      )
        throw error;
      this.recovery ??= this.recover(signal).finally(() => {
        this.recovery = undefined;
      });
      await this.recovery;
      signal.throwIfAborted();
      return operation();
    }
  }
  /** Small presentation header; object maps are loaded separately by the activity feed. */
  get summary(): RecordingState {
    return {
      ...initialState(),
      appliedSeq: this.root.appliedSeq,
      timelineMs: this.root.timelineMs,
      title: this.root.title,
      lifecycle: this.root.lifecycle,
      ...(this.root.completeness
        ? { completeness: { ...this.root.completeness } }
        : {}),
    };
  }
  /** Persisted notice, or a bounded derivation for an ended boundary. At most
   * `limit` of the most recently inserted messages, tools, tasks, interactions and
   * attachments are each checked. */
  completeness(
    signal: AbortSignal,
    limit = 2048,
  ): Promise<CompletenessSummary | undefined> {
    return this.readRecovery(async () => {
      if (this.root.completeness || this.root.lifecycle !== "ended")
        return completenessSummary(this.root);
      let exhaustive = true;
      const count = async <
        K extends "messages" | "tools" | "tasks" | "interactions" | "artifacts",
      >(
        name: K,
        test: (item: PagedItem<K>) => boolean,
      ) => {
        let total = 0;
        const size = this.root.maps[name]?.size ?? 0;
        if (size > limit) exhaustive = false;
        for (
          let offset = Math.max(0, size - limit);
          offset < size;
          offset += 32
        )
          for (const [, item] of await this.reducer.entries(
            this.root,
            name,
            offset,
            32,
            signal,
          ))
            if (test(item)) total++;
        return total;
      };
      const counts = {
        unfinishedMessages: await count("messages", unfinished.message),
        unfinishedTools: await count("tools", unfinished.tool),
        runningTasks: await count("tasks", unfinished.task),
        pendingInteractions: await count(
          "interactions",
          unfinished.interaction,
        ),
        pendingAttachments: await count("artifacts", unfinished.attachment),
      };
      signal.throwIfAborted();
      return completenessSummary(this.root, { ...counts, exhaustive });
    }, signal);
  }
  attachment(artifactId: string, version: number, signal: AbortSignal) {
    return this.readRecovery(
      () => this.attachmentOnce(artifactId, version, signal),
      signal,
    );
  }
  private async attachmentOnce(
    artifactId: string,
    version: number,
    signal: AbortSignal,
  ) {
    const artifact = await this.reducer.get(
      this.root,
      "artifacts",
      artifactId,
      signal,
    );
    if (!artifact || artifact.visible === false) return undefined;
    return this.reducer.artifactVersion(this.root, artifactId, version, signal);
  }
  get sequence() {
    return this.root.appliedSeq;
  }
  private indexed() {
    if (!this.activity)
      throw new ProtocolError(
        "precondition_failed",
        "Activity index requires history rebuild",
      );
    return this.activity;
  }
  get rowCount() {
    return this.indexed().root.visible?.count ?? 0;
  }
  async rows(
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<ActivityRow[]> {
    const { index, root } = this.indexed();
    return (
      await this.readRecovery(
        () => index.entries(root, offset, limit, signal),
        signal,
      )
    ).map((row) => ({
      ...row,
      anchor: objectAnchor(row.kind, row.id),
    }));
  }
  position(key: string, signal: AbortSignal) {
    const { index, root } = this.indexed();
    return this.readRecovery(() => index.position(root, key, signal), signal);
  }
  async load(
    row: ActivityRow,
    signal: AbortSignal,
    versionOffset = 0,
  ): Promise<LoadedActivity | null> {
    return this.readRecovery(
      () => this.loadOnce(row, signal, versionOffset),
      signal,
    );
  }
  private async loadOnce(
    row: ActivityRow,
    signal: AbortSignal,
    versionOffset = 0,
  ): Promise<LoadedActivity | null> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(versionOffset) || versionOffset < 0)
      throw new RangeError("Invalid attachment page");
    const state = initialState(),
      texts: LoadedActivity["texts"] = {};
    Object.assign(state, {
      appliedSeq: this.root.appliedSeq,
      timelineMs: this.root.timelineMs,
      title: this.root.title,
      lifecycle: this.root.lifecycle,
    });
    if (row.kind === "gaps") {
      const index = Number(row.id);
      if (!Number.isSafeInteger(index) || index < 0)
        throw new RangeError("Invalid gap index");
      const gap = (
        await this.reducer.entries(this.root, "gaps", index, 1, signal)
      )[0]?.[1];
      return gap ? { state, texts, gap } : null;
    }
    const item = await this.reducer.get(this.root, row.kind, row.id, signal);
    if (!item || ("visible" in item && item.visible === false)) return null;
    let versions: LoadedActivity["versions"];
    switch (row.kind) {
      case "messages": {
        const value = item as PagedItem<"messages">;
        state.messages.set(row.id, { ...value, text: "" });
        texts.text = this.source(value.text);
        break;
      }
      case "tools": {
        const value = item as PagedItem<"tools">;
        state.tools.set(row.id, { ...value, input: "", output: "" });
        texts.input = this.source(value.input);
        texts.output = this.source(value.output);
        break;
      }
      case "changes": {
        const value = item as PagedItem<"changes">;
        state.changes.set(row.id, { ...value, patch: "" });
        texts.patch = this.source(value.patch);
        break;
      }
      case "artifacts": {
        const value = item as PagedItem<"artifacts">;
        const total = value.versions?.size ?? 0,
          offset = Math.min(
            Math.floor(versionOffset / 32) * 32,
            Math.max(0, Math.floor((total - 1) / 32) * 32),
          );
        const descriptors = await this.reducer.artifactVersions(
          this.root,
          row.id,
          offset,
          32,
          signal,
        );
        state.artifacts.set(row.id, {
          ...value,
          versions: new Map(descriptors.map((item) => [item.version, item])),
        });
        versions = { offset, total };
        break;
      }
      default:
        (state[row.kind] as Map<string, unknown>).set(row.id, item);
    }
    const record = item as Record<string, unknown>;
    for (const key of ["agentId", "parentAgentId"]) {
      const id = record[key];
      if (typeof id === "string" && !state.agents.has(id)) {
        const agent = await this.reducer.get(this.root, "agents", id, signal);
        if (agent) state.agents.set(id, agent);
      }
    }
    if (typeof record.toolId === "string" && !state.tools.has(record.toolId)) {
      const tool = await this.reducer.get(
        this.root,
        "tools",
        record.toolId,
        signal,
      );
      if (tool)
        state.tools.set(record.toolId, { ...tool, input: "", output: "" });
    }
    if (row.kind === "plans") {
      const attachment = state.plans.get(row.id)!.attachment;
      if (attachment) {
        const artifact = await this.reducer.get(
          this.root,
          "artifacts",
          attachment.artifactId,
          signal,
        );
        if (artifact && artifact.visible !== false) {
          const version = await this.reducer.artifactVersion(
            this.root,
            attachment.artifactId,
            attachment.version,
            signal,
          );
          state.artifacts.set(attachment.artifactId, {
            ...artifact,
            versions: new Map(version ? [[version.version, version]] : []),
          });
        }
      }
    }
    signal.throwIfAborted();
    return { state, texts, ...(versions ? { versions } : {}) };
  }
}
