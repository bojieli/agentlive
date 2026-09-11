import { decodeArtifactDataUrl } from "./data-url.js";
import type { RemoteArtifactResolver } from "./artifact-types.js";
import type {
  CapturedAttachment,
  InlineArtifactCapture,
} from "@agentlive/publisher";
import type { EventContent } from "@agentlive/protocol";
export interface NativeMediaResolvers {
  resolveInline: (input: InlineArtifactCapture) => Promise<CapturedAttachment>;
  resolveRemote?: RemoteArtifactResolver;
}
/** Native URL media becomes a generic reference backed by immutable captured bytes. */
export async function nativeMediaEvents(input: {
  url: string;
  mediaKind: "image" | "audio" | "video";
  artifactId: string;
  messageId: string;
  sourceKey: string;
  nativeAgent: string;
  resolvers?: NativeMediaResolvers;
}): Promise<EventContent[]> {
  let attachment: CapturedAttachment | undefined;
  let reason = "Native media requires a configured artifact resolver";
  if (input.resolvers) {
    if (input.url.startsWith("data:")) {
      const decoded = decodeArtifactDataUrl(input.url);
      if (decoded && decoded.mediaType.startsWith(input.mediaKind + "/"))
        attachment = await input.resolvers.resolveInline({
          ...decoded,
          artifactId: input.artifactId,
          sourceKey: input.sourceKey,
          filename: input.mediaKind,
          historical: true,
        });
      else
        reason =
          "Native media data URL has invalid encoding, mismatched media type, or exceeds the capture limit";
    } else if (/^https?:/.test(input.url) && input.resolvers.resolveRemote) {
      const result = await input.resolvers.resolveRemote({
        artifactId: input.artifactId,
        sourceKey: input.sourceKey,
        url: input.url,
        filename: input.mediaKind,
      });
      if ("attachment" in result) {
        if (!result.attachment.mediaType.startsWith(input.mediaKind + "/"))
          throw new Error(
            "Native remote media response does not match its declared kind",
          );
        attachment = result.attachment;
      } else reason = result.reason;
    } else reason = "Native remote media requires an authorized HTTP(S) origin";
  }
  return [
    {
      kind: "attachment.pending",
      payload: { artifactId: input.artifactId, filename: input.mediaKind },
    },
    ...(attachment
      ? ([
          { kind: "attachment.available", payload: { attachment } },
          {
            kind: "reference.resolved",
            payload: {
              messageId: input.messageId,
              sourceReference: `${input.nativeAgent}:attachment/${input.artifactId}`,
              artifactId: input.artifactId,
              version: attachment.version,
            },
          },
        ] as EventContent[])
      : [
          {
            kind: "attachment.unavailable",
            payload: { artifactId: input.artifactId, reason },
          } as EventContent,
        ]),
  ];
}
