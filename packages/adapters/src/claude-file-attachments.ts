import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventContent } from "@agentlive/protocol";
import type {
  CapturedAttachment,
  InlineArtifactCapture,
} from "@agentlive/publisher";
const textFile = z.object({
  type: z.literal("file"),
  filename: z.string(),
  content: z.object({
    type: z.literal("text"),
    file: z.object({
      content: z.string(),
      filePath: z.string(),
      startLine: z.number().int().nonnegative(),
      numLines: z.number().int().nonnegative(),
      totalLines: z.number().int().nonnegative(),
    }),
  }),
});
const edited = z.object({
  type: z.literal("edited_text_file"),
  filename: z.string(),
  snippet: z.string(),
});
const plan = z.object({
  type: z.literal("plan_file_reference"),
  planFilePath: z.string(),
  planContent: z.string(),
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Convert bytes actually retained in the native record; never substitute current local files. */
export async function claudeFileAttachment(
  input: unknown,
  key: string,
  filter: (text: string) => string,
  resolveInline?: (input: InlineArtifactCapture) => Promise<CapturedAttachment>,
): Promise<{ content: EventContent[]; available: boolean } | undefined> {
  const file = textFile.safeParse(input);
  const edit = edited.safeParse(input);
  const recordedPlan = plan.safeParse(input);
  let source: string, bytes: string, label: string, suffix: string;
  if (file.success) {
    const details = file.data.content.file;
    source = file.data.filename;
    label = "Recorded file excerpt";
    suffix = ".excerpt.txt";
    bytes = `Recorded excerpt: ${source}\nStart line: ${details.startLine}; captured lines: ${details.numLines}; source total lines: ${details.totalLines}\n\n${details.content}`;
  } else if (edit.success) {
    source = edit.data.filename;
    label = "Recorded edit snippet";
    suffix = ".snippet.txt";
    bytes = `Recorded edit snippet: ${source}\nThis is the snippet retained by the native session.\n\n${edit.data.snippet}`;
  } else if (recordedPlan.success) {
    source = recordedPlan.data.planFilePath;
    label = "Recorded plan";
    suffix = "";
    bytes = recordedPlan.data.planContent;
  } else return undefined;
  const artifactId = hash("claude-file/" + key);
  const messageId = hash("claude-file-message/" + key);
  const basename = source.split(/[\\/]/).at(-1) || "attachment.txt";
  const filename = filter(basename).slice(0, 200) + suffix;
  const attachment = resolveInline
    ? await resolveInline({
        artifactId,
        sourceKey: "claude/file/" + key,
        filename,
        bytes: Buffer.from(bytes),
        mediaType: recordedPlan.success ? "text/markdown" : "text/plain",
        text: true,
        historical: true,
      })
    : undefined;
  const content: EventContent[] = [
    { kind: "message.started", payload: { messageId, role: "system" } },
    {
      kind: "message.reconciled",
      payload: { messageId, text: filter(label + ": " + source) },
    },
    { kind: "attachment.pending", payload: { artifactId, filename } },
  ];
  if (attachment)
    content.push(
      { kind: "attachment.available", payload: { attachment } },
      {
        kind: "reference.resolved",
        payload: {
          messageId,
          artifactId,
          version: attachment.version,
          sourceReference: "claude:attachment/" + artifactId,
        },
      },
    );
  else
    content.push({
      kind: "attachment.unavailable",
      payload: {
        artifactId,
        reason: "Recorded attachment bytes require an inline artifact resolver",
      },
    });
  if (recordedPlan.success)
    content.push({
      kind: "plan.updated",
      payload: {
        planId: hash("claude-plan/" + source),
        status: "unknown",
        sourceReference: filter(source),
        ...(attachment
          ? { attachment: { artifactId, version: attachment.version } }
          : {}),
      },
    });
  content.push({ kind: "message.completed", payload: { messageId } });
  return { content, available: attachment !== undefined };
}
