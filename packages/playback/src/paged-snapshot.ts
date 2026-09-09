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
  ) {
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
    return new PagedSnapshotReader(root, reducer, content, {
      streamId: binding.streamId,
      revision: binding.revision,
    });
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
  const reader =
    descriptor.format === "agentlive.paged-state"
      ? await PagedSnapshotReader.open(descriptor.ref, binding, content, signal)
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
