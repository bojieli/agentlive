/** Render production workflow components for tests; never write native markup to disk. */
import { createRequire } from "node:module";
import { workflowKinds, WorkflowCard } from "../apps/web/dist/workflow-card.js";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
export function* renderBrowserWorkflows(state) {
  for (const kind of workflowKinds)
    for (const id of state[kind].keys())
      yield renderToStaticMarkup(
        createElement(WorkflowCard, {
          kind,
          id,
          state,
          onAttachment: () => {},
        }),
      );
}
