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
      const comma = descriptor.url.indexOf(",");
      const header = descriptor.url.slice(5, comma);
      const match = /^([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64$/.exec(header);
      if (
        comma >= 0 &&
        match &&
        match[1]!.length <= 128 &&
        (!descriptor.mime ||
          descriptor.mime.toLowerCase() === match[1]!.toLowerCase())
      ) {
        const encoded = descriptor.url.slice(comma + 1);
        if (
          encoded.length <= 32 * 1024 * 1024 &&
          encoded.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        ) {
          const bytes = Buffer.from(encoded, "base64");
          if (bytes.toString("base64") === encoded) {
            const mediaType = match[1]!.toLowerCase();
            attachment = await options.resolvers.resolveInline({
              artifactId: options.artifactId,
              sourceKey,
              bytes,
              filename:
                basename(descriptor.filename).slice(0, 255) || "attachment",
              mediaType,
              text:
                mediaType.startsWith("text/") ||
                [
                  "application/json",
                  "application/javascript",
                  "application/xml",
                  "image/svg+xml",
                ].includes(mediaType),
              historical: true,
            });
          }
        }
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
