import { Disclosure } from "./disclosure.js";
import type { ReactNode } from "react";
import type { RecordingState } from "@agentlive/playback";
import type { Attachment } from "./attachments.js";
export const workflowKinds = [
  "agents",
  "tasks",
  "goals",
  "interactions",
  "plans",
  "monitors",
] as const;
export type WorkflowKind = (typeof workflowKinds)[number];
export const objectAnchor = (kind: string, id: string) =>
  `${kind}-${encodeURIComponent(id)}`;
const label = (value: string) => value.replaceAll("_", " ");
export function AgentReference({
  id,
  state,
}: {
  id?: string;
  state: RecordingState;
}) {
  if (!id) return null;
  const agent = state.agents.get(id);
  return (
    <span className="owner">
      Agent:{" "}
      {agent ? (
        <a href={`#${objectAnchor("agents", id)}`}>{agent.name || id}</a>
      ) : (
        <span>{id} (not available at this position)</span>
      )}
    </span>
  );
}
function ToolReference({ id, state }: { id?: string; state: RecordingState }) {
  if (!id) return null;
  const tool = state.tools.get(id);
  return (
    <p className="muted">
      Related tool:{" "}
      {tool && tool.visible !== false ? (
        <a href={`#${objectAnchor("tools", id)}`}>{tool.name}</a>
      ) : (
        "unavailable at this position"
      )}
    </p>
  );
}
function Field({ name, value }: { name: string; value: ReactNode }) {
  return value === undefined || value === null ? null : (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}
export function WorkflowCard({
  kind,
  id,
  state,
  onAttachment,
}: {
  kind: WorkflowKind;
  id: string;
  state: RecordingState;
  onAttachment: (attachment: Attachment) => void;
}) {
  const value = state[kind].get(id);
  if (!value) return null;
  let title = "",
    body: ReactNode,
    owner: string | undefined;
  switch (kind) {
    case "agents": {
      const agent = state.agents.get(id)!;
      title = agent.name || "Agent";
      body = (
        <dl>
          <Field name="Native session" value={agent.nativeSessionId} />
          <Field
            name="Parent"
            value={
              agent.parentAgentId ? (
                <AgentReference id={agent.parentAgentId} state={state} />
              ) : (
                "Not recorded"
              )
            }
          />
        </dl>
      );
      break;
    }
    case "tasks": {
      const task = state.tasks.get(id)!;
      title = `${label(task.taskType)} task`;
      owner = task.agentId;
      body = (
        <>
          <pre>{task.description || "No description recorded."}</pre>
          {task.detached !== undefined && (
            <p className="muted">
              {task.detached
                ? "Detached from the foreground turn"
                : "Attached to the foreground turn"}
            </p>
          )}
          <ToolReference
            {...(task.toolId ? { id: task.toolId } : {})}
            state={state}
          />
        </>
      );
      break;
    }
    case "goals": {
      const goal = state.goals.get(id)!;
      title = "Goal";
      owner = goal.agentId;
      body = (
        <>
          <pre>{goal.objective || "No objective recorded."}</pre>
          <dl>
            <Field
              name="Completion criterion"
              value={goal.completionCriterion}
            />
            <Field name="Reason" value={goal.reason} />
            <Field
              name="Tokens used"
              value={goal.tokensUsed?.toLocaleString()}
            />
            <Field name="Turns used" value={goal.turnsUsed?.toLocaleString()} />
            <Field
              name="Elapsed"
              value={
                goal.wallClockMs === undefined
                  ? undefined
                  : `${(goal.wallClockMs / 1000).toFixed(1)}s`
              }
            />
          </dl>
        </>
      );
      break;
    }
    case "interactions": {
      const interaction = state.interactions.get(id)!;
      title = interaction.title || `Recorded ${interaction.interactionType}`;
      owner = interaction.agentId;
      body = (
        <>
          <p className="muted">Recorded {interaction.interactionType}</p>
          <pre>{interaction.prompt}</pre>
          {interaction.questions?.map((question, index) => (
            <section className="recorded-question" key={index}>
              {question.header && <strong>{question.header}</strong>}
              <p>{question.question}</p>
              {question.options && (
                <ul>
                  {question.options.map((option, index) => (
                    <li key={index}>
                      <strong>{option.label}</strong>
                      {option.description && (
                        <span> — {option.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <dl>
            <Field name="Scope" value={interaction.scope} />
            <Field
              name="Recorded response"
              value={
                interaction.response === undefined
                  ? interaction.status === "pending"
                    ? "Awaiting recorded response."
                    : "No response retained."
                  : interaction.response || "Empty response"
              }
            />
          </dl>
          <ToolReference
            {...(interaction.toolId ? { id: interaction.toolId } : {})}
            state={state}
          />
        </>
      );
      break;
    }
    case "plans": {
      const plan = state.plans.get(id)!;
      title = `Plan${plan.version === undefined ? "" : ` · version ${plan.version}`}`;
      owner = plan.agentId;
      const artifact =
        plan.attachment && state.artifacts.get(plan.attachment.artifactId);
      const attachment =
        artifact && artifact.visible !== false && plan.attachment
          ? artifact.versions.get(plan.attachment.version)
          : undefined;
      body = (
        <>
          <dl>
            <Field name="Recorded source" value={plan.sourceReference} />
            <Field
              name="Size"
              value={
                plan.byteSize === undefined
                  ? undefined
                  : `${plan.byteSize.toLocaleString()} bytes`
              }
            />
          </dl>
          {attachment ? (
            <button onClick={() => onAttachment(attachment)}>
              Open captured plan
            </button>
          ) : (
            <p className="muted">Plan file unavailable at this position.</p>
          )}
        </>
      );
      break;
    }
    case "monitors": {
      const monitor = state.monitors.get(id)!;
      title = monitor.title || "Monitor";
      body = (
        <dl>
          <Field
            name="Watching"
            value={
              monitor.monitorType === "artifact-comments"
                ? "Artifact comments"
                : "Artifact reactions"
            }
          />
          <Field name="Recorded source" value={monitor.sourceReference} />
          <Field name="Native state" value={monitor.nativeState} />
          <Field
            name="Baseline established"
            value={
              monitor.baselineEstablished === undefined
                ? undefined
                : monitor.baselineEstablished
                  ? "Yes"
                  : "No"
            }
          />
          <Field
            name="Threads observed"
            value={
              monitor.hasObservedThreads === undefined
                ? undefined
                : monitor.hasObservedThreads
                  ? "Yes"
                  : "No"
            }
          />
        </dl>
      );
      break;
    }
  }
  return (
    <article
      className="card workflow"
      id={objectAnchor(kind, id)}
      tabIndex={-1}
    >
      <div className="workflow-heading">
        <h3>{title}</h3>
        <span className={`workflow-status status-${value.status}`}>
          {label(value.status)}
        </span>
      </div>
      <AgentReference {...(owner ? { id: owner } : {})} state={state} />
      {body}
      <Disclosure
        choice={`${kind}/${id}/recorded-data`}
        className="recorded-data"
      >
        <summary>Recorded data</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </Disclosure>
    </article>
  );
}
