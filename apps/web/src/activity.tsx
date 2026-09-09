import type { RecordingState } from "@agentlive/playback";
import type { Attachment } from "./attachments.js";
import {
  AgentReference,
  objectAnchor,
  WorkflowCard,
  workflowKinds,
  type WorkflowKind,
} from "./workflow-card.js";
import { PagedText } from "./paged-text.js";
import { Disclosure } from "./disclosure.js";
export type ActivityKind =
  WorkflowKind | "messages" | "tools" | "changes" | "artifacts" | "gaps";
export interface ActivityRow {
  key: string;
  kind: ActivityKind;
  id: string;
  anchor: string;
}
/** Lightweight row descriptors; expensive JSX and text formatting are viewport-only. */
export function activityRows(
  state: RecordingState,
  order: (key: string) => number,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const kind of [
    "messages",
    "tools",
    "changes",
    "artifacts",
    ...workflowKinds,
  ] as const) {
    for (const [id, value] of state[kind]) {
      if ("visible" in value && value.visible === false) continue;
      rows.push({
        key: `${kind}/${id}`,
        kind,
        id,
        anchor: objectAnchor(kind, id),
      });
    }
  }
  rows.sort((a, b) => order(a.key) - order(b.key));
  for (let index = 0; index < state.gaps.length; index++)
    rows.push({
      key: `gaps/${index}`,
      kind: "gaps",
      id: String(index),
      anchor: objectAnchor("gaps", String(index)),
    });
  return rows;
}
export function ActivityCard({
  row,
  state,
  onAttachment,
}: {
  row: ActivityRow;
  state: RecordingState;
  onAttachment: (attachment: Attachment) => void;
}) {
  const { kind, id } = row;
  switch (kind) {
    case "messages": {
      const message = state.messages.get(id)!;
      return (
        <article className={`message ${message.role}`} id={row.anchor}>
          <div className="item-label">
            {message.role}
            <span>{message.completed ? "" : "in progress"}</span>
          </div>
          <AgentReference
            {...(message.agentId ? { id: message.agentId } : {})}
            state={state}
          />
          <PagedText
            text={message.text || "…"}
            group={row.key}
            choice={`${row.key}/text`}
            label="Message"
          />
        </article>
      );
    }
    case "tools": {
      const tool = state.tools.get(id)!;
      return (
        <Disclosure choice={row.key} className="card" id={row.anchor}>
          <summary>
            {tool.name} <span className="muted">{tool.status}</span>
          </summary>
          <AgentReference
            {...(tool.agentId ? { id: tool.agentId } : {})}
            state={state}
          />
          <h4>Input</h4>
          <PagedText
            text={tool.input}
            group={row.key}
            choice={`${row.key}/input`}
            label="Tool input"
          />
          <h4>Output</h4>
          <PagedText
            text={tool.output}
            group={row.key}
            choice={`${row.key}/output`}
            label="Tool output"
          />
        </Disclosure>
      );
    }
    case "changes": {
      const change = state.changes.get(id)!;
      return (
        <Disclosure choice={row.key} className="card" id={row.anchor}>
          <summary>{change.path}</summary>
          <PagedText
            text={change.patch}
            group={row.key}
            choice={`${row.key}/patch`}
            label="Diff"
          />
        </Disclosure>
      );
    }
    case "artifacts": {
      const artifact = state.artifacts.get(id)!;
      return (
        <section className="card" id={row.anchor}>
          <strong>{artifact.filename}</strong>
          <p className="muted">
            {artifact.reason ??
              (artifact.pending
                ? "Preparing attachment…"
                : `${artifact.versions.size} saved version(s)`)}
          </p>
          {[...artifact.versions.values()].map((version) => (
            <button key={version.version} onClick={() => onAttachment(version)}>
              Open version {version.version}
            </button>
          ))}
        </section>
      );
    }
    case "gaps":
      return (
        <div className="gap">
          Capture note: {state.gaps[Number(id)]!.reason}
        </div>
      );
    default:
      return (
        <WorkflowCard
          kind={kind}
          id={id}
          state={state}
          onAttachment={onAttachment}
        />
      );
  }
}
