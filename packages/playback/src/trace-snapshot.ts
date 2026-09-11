import {
  ProtocolError,
  snapshotDescriptorSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import { PagedReducer, type PagedContent } from "./paged-reducer.js";
import { ActivityIndex } from "./activity-index.js";
import type { ContentReference, SnapshotBinding } from "./snapshot.js";
/** Trace a coherent paired checkpoint. Callback output is provisional until success.
 * Caller owns root pins, codec-page tracing and any later reclamation.
 */
export async function tracePairedSnapshot(
  content: PagedContent,
  descriptor: SnapshotDescriptor,
  binding: SnapshotBinding,
  visit: (reference: ContentReference) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  binding = { ...binding };
  const selected = snapshotDescriptorSchema.parse(descriptor);
  if (selected.format !== "agentlive.paged-state" || !selected.activity)
    throw new ProtocolError(
      "invalid_request",
      "Tracing requires a paired paged checkpoint",
    );
  const reducer = new PagedReducer(content),
    activity = new ActivityIndex(content);
  const state = await reducer.open(selected.ref, binding, signal);
  const rows = await activity.open(selected.activity, binding, signal);
  if (
    state.appliedSeq !== selected.serverSeq ||
    state.timelineMs !== selected.timelineMs ||
    rows.appliedSeq !== state.appliedSeq ||
    rows.gaps !== (state.maps.gaps?.size ?? 0)
  )
    throw new ProtocolError(
      "corrupt_storage",
      "Paired checkpoint boundaries differ",
    );
  await reducer.trace(selected.ref, binding, visit, signal);
  await activity.trace(selected.activity, binding, visit, signal);
  signal?.throwIfAborted();
}
