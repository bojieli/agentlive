import type { ReducedCompletenessNotice } from "@agentlive/protocol";
/** Unfinished-work counts a viewer can derive from reduced state at an ended boundary. */
export interface UnfinishedCounts {
  unfinishedMessages: number;
  unfinishedTools: number;
  runningTasks: number;
  pendingInteractions: number;
  pendingAttachments: number;
}
/** A persisted `capture.completeness` notice, or a replay-time derivation from an ended boundary. */
export type CompletenessSummary =
  | ({ source: "recorded" } & ReducedCompletenessNotice)
  | ({
      source: "derived";
      /** False when a bounded viewer scan stopped before checking every object. */
      exhaustive: boolean;
    } & UnfinishedCounts);
/** Persisted notices win. Derived notices apply only to ended boundaries with unfinished work. */
export function completenessSummary(
  state: {
    lifecycle: "open" | "ended";
    completeness?: ReducedCompletenessNotice;
  },
  derived?: Partial<UnfinishedCounts> & {
    unfinishedMessages: number;
    unfinishedTools: number;
    exhaustive?: boolean;
  },
): CompletenessSummary | undefined {
  if (state.completeness) return { source: "recorded", ...state.completeness };
  if (state.lifecycle !== "ended" || !derived) return undefined;
  const counts: UnfinishedCounts = {
    unfinishedMessages: derived.unfinishedMessages,
    unfinishedTools: derived.unfinishedTools,
    runningTasks: derived.runningTasks ?? 0,
    pendingInteractions: derived.pendingInteractions ?? 0,
    pendingAttachments: derived.pendingAttachments ?? 0,
  };
  if (!Object.values(counts).some(Boolean)) return undefined;
  return {
    source: "derived",
    ...counts,
    exhaustive: derived.exhaustive ?? true,
  };
}
const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;
const was = (value: number) => (value === 1 ? "was" : "were");
/** Shared terminal/browser wording. Counts only; never recorded content. */
export function completenessText(summary: CompletenessSummary): {
  title: string;
  details: string[];
} {
  const details: string[] = [];
  const prefix =
    summary.source === "derived" && !summary.exhaustive ? "At least " : "";
  if (summary.unfinishedMessages)
    details.push(
      `${prefix}${count(summary.unfinishedMessages, "message")} never completed.`,
    );
  if (summary.unfinishedTools)
    details.push(
      `${prefix}${count(summary.unfinishedTools, "tool call")} never completed.`,
    );
  // Version 1 notices predate these counts; they say nothing about these objects.
  const extended =
    summary.source === "derived" || summary.version === 2 ? summary : undefined;
  if (extended?.runningTasks)
    details.push(
      `${prefix}${count(extended.runningTasks, "task")} ${was(extended.runningTasks)} still running.`,
    );
  if (extended?.pendingInteractions)
    details.push(
      `${prefix}${extended.pendingInteractions} ${extended.pendingInteractions === 1 ? "approval or question was" : "approvals or questions were"} still awaiting a response.`,
    );
  if (extended?.pendingAttachments)
    details.push(
      `${prefix}${count(extended.pendingAttachments, "attachment")} ${was(extended.pendingAttachments)} still pending.`,
    );
  if (summary.source === "recorded" && summary.withheldTextMessages)
    details.push(
      `${count(summary.withheldTextMessages, "message")} ${summary.withheldTextMessages === 1 ? "has" : "have"} trailing text withheld because it may begin a redacted secret; the withheld text is not part of this recording.`,
    );
  details.push("Content shown for unfinished items is partial.");
  return {
    title:
      summary.source === "recorded"
        ? "Incomplete capture: the native session was unfinished when this recording was imported"
        : "Incomplete activity: the recording ended before some captured work finished",
    details,
  };
}
