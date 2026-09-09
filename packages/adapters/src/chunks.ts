import { createHash } from "node:crypto";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
/** Keep individual normalized events below the publish budget without losing large source text. */
export function chunkContent(content: EventContent): EventContent[] {
  const serialized = canonicalJson(content);
  if (Buffer.byteLength(serialized) <= 48 * 1024) return [content];
  if (
    content.kind === "message.text.append" ||
    content.kind === "tool.output.append" ||
    content.kind === "tool.arguments.append"
  ) {
    const chunks: EventContent[] = [];
    for (let offset = 0; offset < content.payload.text.length; offset += 8000)
      chunks.push({
        ...content,
        payload: {
          ...content.payload,
          text: content.payload.text.slice(offset, offset + 8000),
        },
      } as EventContent);
    return chunks;
  }
  const replacementId = createHash("sha256").update(serialized).digest("hex");
  const replace = (
    target: "message" | "tool.input" | "tool.output" | "change.patch",
    targetId: string,
    text: string,
  ): EventContent[] => {
    const chunks: EventContent[] = [
      {
        kind: "text.replacement.started",
        payload: { replacementId, target, targetId },
      },
    ];
    let index = 0;
    for (let offset = 0; offset < text.length; offset += 8000)
      chunks.push({
        kind: "text.replacement.chunk",
        payload: {
          replacementId,
          index: index++,
          text: text.slice(offset, offset + 8000),
        },
      });
    chunks.push({
      kind: "text.replacement.completed",
      payload: { replacementId, parts: index },
    });
    return chunks;
  };
  switch (content.kind) {
    case "message.reconciled":
      return replace(
        "message",
        content.payload.messageId,
        content.payload.text,
      );
    case "tool.started":
      return [
        { ...content, payload: { ...content.payload, input: "" } },
        ...replace("tool.input", content.payload.toolId, content.payload.input),
      ];
    case "tool.arguments.ready":
      return replace(
        "tool.input",
        content.payload.toolId,
        content.payload.input,
      );
    case "tool.completed":
      if (content.payload.output !== undefined) {
        const { output, ...payload } = content.payload;
        return [
          ...replace("tool.output", payload.toolId, output),
          { kind: "tool.completed", payload },
        ];
      }
      break;
    case "file.change.proposed":
    case "file.change.applied":
      return [
        { ...content, payload: { ...content.payload, patch: "" } },
        ...replace(
          "change.patch",
          content.payload.changeId,
          content.payload.patch,
        ),
      ];
  }
  throw new Error(
    "Normalized event needs an attachment or a supported chunk strategy",
  );
}
