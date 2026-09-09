import { expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  WorkflowCard,
  type WorkflowKind,
} from "../../apps/web/src/workflow-card.js";
import { apply, initialState } from "../../packages/playback/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function fixture() {
  let state = initialState();
  return {
    append(content: EventContent) {
      const event: StoredEvent = {
        protocolVersion: 1,
        serverSeq: state.appliedSeq + 1,
        timelineMs: state.appliedSeq * 1000,
        receivedAt: "2026-09-09T00:00:00Z",
        content,
        origin: { type: "server", operationId: `op${state.appliedSeq}` },
      };
      state = apply(state, event);
    },
    render(kind: WorkflowKind, id: string) {
      return renderToStaticMarkup(
        createElement(WorkflowCard, {
          kind,
          id,
          state,
          onAttachment: () => {},
        }),
      );
    },
  };
}
it("renders agent ownership, parent relationships and task/tool status without exposing hidden tools", () => {
  const view = fixture();
  view.append({
    kind: "agent.updated",
    payload: {
      agentId: "parent",
      nativeSessionId: "session",
      name: "Coordinator",
      status: "active",
    },
  });
  view.append({
    kind: "agent.updated",
    payload: {
      agentId: "child",
      parentAgentId: "parent",
      nativeSessionId: "child-session",
      name: "Researcher",
      status: "completed",
    },
  });
  view.append({
    kind: "tool.started",
    payload: { toolId: "tool", name: "Read file", input: "example.txt" },
  });
  view.append({
    kind: "task.updated",
    payload: {
      taskId: "task",
      agentId: "child",
      toolId: "tool",
      taskType: "process",
      description: "Inspect the fixture",
      status: "timed_out",
      detached: true,
    },
  });
  expect(view.render("agents", "child")).toContain(
    'href="#agents-parent">Coordinator',
  );
  const task = view.render("tasks", "task");
  expect(task).toContain('href="#agents-child">Researcher');
  expect(task).toContain('href="#tools-tool">Read file');
  expect(task).toContain(">timed out</span>");
  expect(task).toContain("Detached from the foreground turn");
  view.append({
    kind: "object.visibility",
    payload: { objectType: "tool", objectId: "tool", visible: false },
  });
  expect(view.render("tasks", "task")).not.toContain('href="#tools-tool"');
  expect(view.render("tasks", "task")).toContain(
    "unavailable at this position",
  );
});
it("renders zero goal usage and monitor baselines as recorded values", () => {
  const view = fixture();
  view.append({
    kind: "goal.updated",
    payload: {
      goalId: "goal",
      objective: "Complete the feature",
      status: "paused",
      reason: "Waiting for results",
      completionCriterion: "Tests pass",
      tokensUsed: 0,
      turnsUsed: 0,
      wallClockMs: 0,
    },
  });
  const goal = view.render("goals", "goal");
  expect(goal).toContain("<dt>Tokens used</dt><dd>0</dd>");
  expect(goal).toContain("<dt>Turns used</dt><dd>0</dd>");
  expect(goal).toContain("<dt>Elapsed</dt><dd>0.0s</dd>");
  expect(goal).toContain("<dt>Reason</dt><dd>Waiting for results</dd>");
  view.append({
    kind: "monitor.updated",
    payload: {
      monitorId: "monitor",
      monitorType: "artifact-comments",
      sourceReference: "artifact:example",
      title: "Review comments",
      status: "armed",
      baselineEstablished: true,
      hasObservedThreads: false,
    },
  });
  const monitor = view.render("monitors", "monitor");
  expect(monitor).toContain("<dt>Baseline established</dt><dd>Yes</dd>");
  expect(monitor).toContain("<dt>Threads observed</dt><dd>No</dd>");
});
it("keeps recorded decisions passive and only shows a response after it is recorded", () => {
  const view = fixture();
  const payload = {
    interactionId: "ask",
    interactionType: "approval" as const,
    title: "Run the command?",
    prompt: "<script>untrusted()</script>",
    questions: [
      {
        question: "Choose scope",
        options: [{ label: "Once", description: "This invocation" }],
      },
    ],
  };
  view.append({
    kind: "interaction.updated",
    payload: { ...payload, status: "pending" },
  });
  const pending = view.render("interactions", "ask");
  expect(pending).toContain("Awaiting recorded response.");
  expect(pending).not.toContain("APPROVED_RESPONSE");
  expect(pending).not.toContain("<button");
  expect(pending).not.toContain("<script>");
  expect(pending).toContain("&lt;script&gt;");
  view.append({
    kind: "interaction.updated",
    payload: { ...payload, status: "resolved", response: "APPROVED_RESPONSE" },
  });
  expect(view.render("interactions", "ask")).toContain(
    "<dd>APPROVED_RESPONSE</dd>",
  );
});
it("offers only captured and currently visible plan versions, never the native URL", () => {
  const view = fixture();
  view.append({
    kind: "plan.updated",
    payload: {
      planId: "plan",
      version: 1,
      status: "active",
      sourceReference: "https://native.example/private-plan",
    },
  });
  expect(view.render("plans", "plan")).toContain(
    "Plan file unavailable at this position.",
  );
  view.append({
    kind: "attachment.available",
    payload: {
      attachment: {
        artifactId: "file",
        version: 1,
        hash: "a".repeat(64),
        byteSize: 20,
        filename: "plan.md",
        mediaType: "text/markdown",
      },
    },
  });
  view.append({
    kind: "plan.updated",
    payload: {
      planId: "plan",
      version: 1,
      status: "active",
      sourceReference: "https://native.example/private-plan",
      attachment: { artifactId: "file", version: 1 },
    },
  });
  const visible = view.render("plans", "plan");
  expect(visible).toContain("<button>Open captured plan</button>");
  expect(visible).not.toContain('href="https://native.example');
  view.append({
    kind: "object.visibility",
    payload: { objectType: "attachment", objectId: "file", visible: false },
  });
  expect(view.render("plans", "plan")).not.toContain("<button");
});
