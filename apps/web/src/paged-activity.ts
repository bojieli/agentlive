import {
  initialState,
  type RecordingState,
  type PagedReducer,
  type PagedRecordingState,
  type ContentReference,
  type PagedItem,
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
  ) {
    this.root = structuredClone(root);
  }
  get sequence() {
    return this.root.appliedSeq;
  }
  async load(
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
