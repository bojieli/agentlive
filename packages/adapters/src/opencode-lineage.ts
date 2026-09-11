import { createHash } from "node:crypto";
import type { EventContent } from "@agentlive/protocol";
export const openCodeAgentId = (nativeSessionId: string) =>
  createHash("sha256")
    .update(`opencode-agent/${nativeSessionId}`)
    .digest("hex");
/** Parent IDs are source evidence; an absent parent's transcript/status remains unknown. */
export function openCodeLineage(
  nativeSessionId: string,
  parentID: string,
): EventContent[] {
  return [
    {
      kind: "agent.updated",
      payload: {
        agentId: openCodeAgentId(parentID),
        nativeSessionId: parentID,
        status: "unknown",
      },
    },
    {
      kind: "agent.updated",
      payload: {
        agentId: openCodeAgentId(nativeSessionId),
        nativeSessionId,
        parentAgentId: openCodeAgentId(parentID),
        status: "unknown",
      },
    },
  ];
}
