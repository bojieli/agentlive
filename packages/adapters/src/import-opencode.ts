import { StreamingRedactor } from "@agentlive/publisher";
import {
  visibleOpenCodeSnapshot,
  type OpenCodeSnapshot,
} from "./opencode-history.js";
import { inspectOpenCodeImportFamily } from "./opencode-import-family.js";
import { OpenCodeCapture } from "./opencode-capture.js";
import {
  inspectOpenCodeHistory,
  readOpenCodeImportSnapshot,
} from "./opencode-history.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
/** Report frozen-source incompleteness without releasing secret-prefix tails. */
export function openCodeFrozenCompleteness(
  input: OpenCodeSnapshot,
  secrets: readonly string[],
) {
  let unfinishedMessages = 0,
    withheldTextMessages = 0;
  for (const message of visibleOpenCodeSnapshot(input).messages) {
    if (
      message.info.role !== "assistant" ||
      message.info.time.completed !== undefined
    )
      continue;
    unfinishedMessages++;
    const texts = message.parts
      .filter((part) => part.type === "text")
      .map((part) => {
        if (typeof part.text !== "string")
          throw new Error("Invalid OpenCode text part");
        return part.text;
      });
    if (message.info.error) {
      const error = message.info.error as Record<string, unknown>;
      const data =
        error.data && typeof error.data === "object"
          ? (error.data as Record<string, unknown>)
          : {};
      texts.push(
        typeof data.message === "string"
          ? data.message
          : typeof error.message === "string"
            ? error.message
            : "OpenCode source error (details unavailable)",
      );
    }
    const redactor = new StreamingRedactor(secrets);
    redactor.push(texts.join("\n"));
    // Only inspect whether finalization would release a suffix. Never persist it.
    if (redactor.finish().length > 0) withheldTextMessages++;
  }
  return { unfinishedMessages, withheldTextMessages };
}
export type OpenCodeImportOptions = NativeImportOptions & {
  familyRoot?: string;
};
export async function importOpenCodeRecording(options: OpenCodeImportOptions) {
  const source = await inspectOpenCodeHistory(
    options.sourcePath,
    options.signal,
  );
  const family = options.familyRoot
    ? await inspectOpenCodeImportFamily(
        options.familyRoot,
        options.sourcePath,
        source,
        options.signal,
      )
    : [];
  return importNativeRecording(options, {
    agent: "opencode",
    converterVersion: options.familyRoot
      ? "opencode-snapshot-4-family-import-1"
      : "opencode-snapshot-4",
    ...(options.familyRoot
      ? {
          familySources: family.map((child) => ({
            sourcePath: child.sourcePath,
            nativeAgent: child.nativeAgent,
            boundary: child.manifest.boundary,
          })),
        }
      : {}),
    source,
    capture: async (journal, secrets, artifacts) => {
      const snapshot = await readOpenCodeImportSnapshot(
        options.sourcePath,
        source,
        options.signal,
      );
      const capture = await OpenCodeCapture.open(journal, secrets, artifacts);
      try {
        await capture.accept(snapshot, options.signal);
      } finally {
        await capture.close();
      }
      const report = {
        ...openCodeFrozenCompleteness(snapshot, secrets),
        records: snapshot.messages.length,
        items: snapshot.messages.reduce(
          (count, message) => count + message.parts.length,
          0,
        ),
        omittedReasoning: snapshot.messages.reduce(
          (count, message) =>
            count +
            message.parts.filter((part) => part.type === "reasoning").length,
          0,
        ),
        unavailableAttachments: 0,
        availableAttachments: 0,
        unsupported: {} as Record<string, number>,
      };
      for (const child of family) {
        const snapshot = await readOpenCodeImportSnapshot(
          child.sourcePath,
          child.manifest,
          options.signal,
        );
        const childCapture = await OpenCodeCapture.open(
          journal,
          secrets,
          artifacts,
          {
            nativeSessionId: child.nativeAgent,
            parentNativeSessionId: child.manifest.parentNativeSessionId!,
          },
        );
        try {
          await childCapture.accept(snapshot, options.signal);
        } finally {
          await childCapture.close();
        }
        const completeness = openCodeFrozenCompleteness(snapshot, secrets);
        report.unfinishedMessages += completeness.unfinishedMessages;
        report.withheldTextMessages += completeness.withheldTextMessages;
        report.records += snapshot.messages.length;
        report.items += snapshot.messages.reduce(
          (count, message) => count + message.parts.length,
          0,
        );
        report.omittedReasoning += snapshot.messages.reduce(
          (count, message) =>
            count +
            message.parts.filter((part) => part.type === "reasoning").length,
          0,
        );
      }
      // Count the durable prefix so retry reports describe the same recording.
      for await (const event of journal.pending(0)) {
        options.signal.throwIfAborted();
        if (event.content.kind === "attachment.available")
          report.availableAttachments++;
        if (event.content.kind === "attachment.unavailable")
          report.unavailableAttachments++;
        if (event.content.kind === "capture.gap") {
          const reason = event.content.payload.reason;
          report.unsupported[reason] = (report.unsupported[reason] ?? 0) + 1;
        }
      }
      return report;
    },
    withheldTextMessages: (report) => report.withheldTextMessages,
  });
}
