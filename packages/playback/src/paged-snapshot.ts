import { ActivityIndex, type ActivityIndexRoot } from "./activity-index.js";
import {
  type SnapshotDescriptor,
  ProtocolError,
  snapshotDescriptorSchema,
} from "@agentlive/protocol";
import { PagedReducer, type PagedRecordingState } from "./paged-reducer.js";
import {
  SnapshotReader,
  type SnapshotBinding,
  type SnapshotContent,
  type ContentReference,
} from "./snapshot.js";
import type { OrderedMapKey } from "./ordered-map.js";
/** Read-only access to a paged checkpoint; object and text reads remain lazy. */
export class PagedSnapshotReader {
  readonly format = "agentlive.paged-state";
  readonly manifest: Readonly<
    SnapshotBinding & { serverSeq: number; timelineMs: number }
  >;
  private constructor(
    private readonly root: PagedRecordingState,
    private readonly reducer: PagedReducer,
    private readonly content: SnapshotContent,
    binding: SnapshotBinding,
    private readonly activity: {
      index: ActivityIndex;
      root: ActivityIndexRoot;
    } | null,
  ) {
    this.manifest = Object.freeze({
      ...binding,
      serverSeq: root.appliedSeq,
      timelineMs: root.timelineMs,
    });
  }
  static async open(
    ref: ContentReference,
    binding: SnapshotBinding,
    content: SnapshotContent,
    signal?: AbortSignal,
    activityReference?: ContentReference,
  ) {
    ref = { ...ref };
    binding = { streamId: binding.streamId, revision: binding.revision };
    activityReference = activityReference
      ? { ...activityReference }
      : undefined;
    const reducer = new PagedReducer({
      read: content.read.bind(content),
      put: async () => {
        throw new Error("Snapshot reader is read-only");
      },
      append: async () => {
        throw new Error("Snapshot reader is read-only");
      },
    });
    const root = await reducer.open(ref, binding, signal);
    let activity: { index: ActivityIndex; root: ActivityIndexRoot } | null =
      null;
    if (activityReference) {
      const index = new ActivityIndex(content);
      const rows = await index.open(activityReference, binding, signal);
      if (
        rows.appliedSeq !== root.appliedSeq ||
        rows.gaps !== (root.maps.gaps?.size ?? 0)
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Snapshot activity boundary differs from state",
        );
      activity = { index, root: rows };
    }
    return new PagedSnapshotReader(
      root,
      reducer,
      content,
      {
        streamId: binding.streamId,
        revision: binding.revision,
      },
      activity,
    );
  }
  get activityState() {
    return this.activity ? structuredClone(this.activity.root) : null;
  }
  private indexed() {
    if (!this.activity)
      throw new ProtocolError(
        "precondition_failed",
        "Snapshot has no activity index",
      );
    return this.activity;
  }
  async activityRows(offset: number, limit: number, signal?: AbortSignal) {
    const { index, root } = this.indexed();
    return index.entries(root, offset, limit, signal);
  }
  async activityPosition(key: string, signal?: AbortSignal) {
    const { index, root } = this.indexed();
    return index.position(root, key, signal);
  }

  get state(): PagedRecordingState {
    return structuredClone(this.root);
  }
  get<K extends keyof PagedRecordingState["maps"]>(
    name: K,
    key: OrderedMapKey,
    signal?: AbortSignal,
  ) {
    return this.reducer.get(this.root, name, key, signal);
  }
  entries<K extends keyof PagedRecordingState["maps"]>(
    name: K,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return this.reducer.entries(this.root, name, offset, limit, signal);
  }
  text(
    ref: ContentReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    return this.content.read(ref, offset, length, signal);
  }
  materialize(maxUnits?: number, signal?: AbortSignal) {
    return this.reducer.materialize(this.root, maxUnits, signal);
  }
}
/** Descriptors without a format identify the original snapshot codec. Never guess from failed decoding. */
export async function openRecordingSnapshot(
  descriptor: SnapshotDescriptor,
  binding: SnapshotBinding,
  content: SnapshotContent,
  signal?: AbortSignal,
) {
  descriptor = snapshotDescriptorSchema.parse(descriptor);
  binding = { streamId: binding.streamId, revision: binding.revision };
  if (descriptor.activity && descriptor.format !== "agentlive.paged-state")
    throw new ProtocolError(
      "corrupt_storage",
      "Legacy snapshot cannot contain an activity index",
    );
  const reader =
    descriptor.format === "agentlive.paged-state"
      ? await PagedSnapshotReader.open(
          descriptor.ref,
          binding,
          content,
          signal,
          descriptor.activity,
        )
      : await SnapshotReader.open(descriptor.ref, binding, content, signal);
  if (
    reader.manifest.serverSeq !== descriptor.serverSeq ||
    reader.manifest.timelineMs !== descriptor.timelineMs
  )
    throw new ProtocolError(
      "corrupt_storage",
      "Snapshot descriptor boundary differs from manifest",
    );
  return reader;
}
