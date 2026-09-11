import type { ReducedCompletenessNotice } from "@agentlive/protocol";
/** A persisted `capture.completeness` notice, or a replay-time derivation from an ended boundary. */
export type CompletenessSummary =
  | ({ source: "recorded" } & ReducedCompletenessNotice)
  | {
      source: "derived";
      unfinishedMessages: number;
      unfinishedTools: number;
      /** False when a bounded viewer scan stopped before checking every object. */
      exhaustive: boolean;
    };
/** Persisted notices win. Derived notices apply only to ended boundaries with unfinished work. */
export function completenessSummary(
  state: {
    lifecycle: "open" | "ended";
    completeness?: ReducedCompletenessNotice;
  },
  derived?: {
    unfinishedMessages: number;
    unfinishedTools: number;
    exhaustive?: boolean;
  },
): CompletenessSummary | undefined {
  if (state.completeness) return { source: "recorded", ...state.completeness };
  if (
    state.lifecycle !== "ended" ||
    !derived ||
    (!derived.unfinishedMessages && !derived.unfinishedTools)
  )
    return undefined;
  return {
    source: "derived",
    unfinishedMessages: derived.unfinishedMessages,
    unfinishedTools: derived.unfinishedTools,
    exhaustive: derived.exhaustive ?? true,
  };
}
const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;
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
