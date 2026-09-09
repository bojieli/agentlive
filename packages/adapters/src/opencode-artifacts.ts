import { decodeArtifactDataUrl } from "./data-url.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import type {
  CapturedAttachment,
  InlineArtifactCapture,
} from "@agentlive/publisher";
import type { FileArtifactResolver } from "./artifact-types.js";
export interface OpenCodeArtifactResolvers {
  resolveArtifact: FileArtifactResolver;
  resolveInline: (input: InlineArtifactCapture) => Promise<CapturedAttachment>;
}
export function openCodeFileDescriptor(part: Record<string, unknown>) {
  return {
    url: typeof part.url === "string" ? part.url : "",
    mime: typeof part.mime === "string" ? part.mime : "",
    filename: typeof part.filename === "string" ? part.filename : "attachment",
  };
}
/** Never persist raw data URLs or fetch arbitrary remote artifact URLs. */
export async function openCodeFileEvents(options: {
  part: Record<string, unknown>;
  artifactId: string;
  messageId: string;
  sourceScope: string;
  resolvers?: OpenCodeArtifactResolvers;
  filter: (text: string) => string;
}): Promise<EventContent[]> {
  const descriptor = openCodeFileDescriptor(options.part);
  const sourceKey = `opencode-file/${createHash("sha256")
    .update(
      canonicalJson({
        scope: options.sourceScope,
        artifactId: options.artifactId,
        descriptor,
      }),
    )
    .digest("hex")}`;
  let attachment: CapturedAttachment | undefined;
  let reason = "OpenCode file reference requires artifact conversion";
  if (options.resolvers) {
    if (descriptor.url.startsWith("file:")) {
      let valid = true;
      try {
        fileURLToPath(descriptor.url);
      } catch {
        valid = false;
      }
      const result = valid
        ? await options.resolvers.resolveArtifact({
            artifactId: options.artifactId,
            sourceKey,
            path: descriptor.url,
            historical: true,
          })
        : { reason: "OpenCode local artifact URL is invalid" };
      if ("attachment" in result) attachment = result.attachment;
      else reason = result.reason;
    } else if (descriptor.url.startsWith("data:")) {
      const decoded = decodeArtifactDataUrl(descriptor.url, descriptor.mime);
      if (decoded) {
        attachment = await options.resolvers.resolveInline({
          artifactId: options.artifactId,
          sourceKey,
          ...decoded,
          filename: basename(descriptor.filename).slice(0, 255) || "attachment",
          historical: true,
        });
      }
      if (!attachment)
        reason =
          "OpenCode inline attachment has unsupported encoding, mismatched media type, or exceeds the size limit";
    } else
      reason =
        "OpenCode remote artifact URL requires an authenticated source resolver";
  }
  const events: EventContent[] = [
    {
      kind: "attachment.pending",
      payload: {
        artifactId: options.artifactId,
        filename: options.filter(
          basename(descriptor.filename).slice(0, 255) || "attachment",
        ),
      },
    },
  ];
  if (attachment)
    events.push(
      { kind: "attachment.available", payload: { attachment } },
      {
        kind: "reference.resolved",
        payload: {
          messageId: options.messageId,
          sourceReference: descriptor.url.startsWith("file:")
            ? options.filter(descriptor.url).slice(0, 4096)
            : `opencode:attachment/${options.artifactId}`,
          artifactId: options.artifactId,
          version: attachment.version,
        },
      },
    );
  else
    events.push({
      kind: "attachment.unavailable",
      payload: {
        artifactId: options.artifactId,
        reason: options.filter(reason),
      },
    });
  return events;
}
