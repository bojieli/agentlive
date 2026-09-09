import { OpenCodeCapture } from "./opencode-capture.js";
import {
  inspectOpenCodeHistory,
  readOpenCodeImportSnapshot,
} from "./opencode-history.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
export type OpenCodeImportOptions = NativeImportOptions;
export async function importOpenCodeRecording(options: OpenCodeImportOptions) {
  const source = await inspectOpenCodeHistory(
    options.sourcePath,
    options.signal,
  );
  return importNativeRecording(options, {
    agent: "opencode",
    converterVersion: "opencode-snapshot-4",
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
  });
}
