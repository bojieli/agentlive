import {
  inspectClaudeHistory,
  captureClaudeHistory,
} from "./claude-history.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
export type ClaudeImportOptions = NativeImportOptions;
export async function importClaudeRecording(options: ClaudeImportOptions) {
  const source = await inspectClaudeHistory(options.sourcePath, options.signal);
  return importNativeRecording(options, {
    agent: "claude",
    converterVersion: "claude-history-4",
    source,
    capture: (journal, secrets, artifacts) =>
      captureClaudeHistory(
        options.sourcePath,
        source,
        journal,
        secrets,
        options.signal,
        artifacts.resolveInline,
      ),
  });
}
