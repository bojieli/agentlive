import { CodexCapture } from "./codex.js";
import { inspectCodexHistory, captureCodexHistory } from "./codex-history.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
export type CodexImportOptions = NativeImportOptions;
export async function importCodexRecording(options: CodexImportOptions) {
  const source = await inspectCodexHistory(options.sourcePath, options.signal);
  return importNativeRecording(options, {
    agent: "codex",
    converterVersion: "codex-history-3",
    source,
    capture: (journal, secrets, artifacts) =>
      captureCodexHistory(
        options.sourcePath,
        source,
        new CodexCapture(
          journal,
          secrets,
          source.createdAt,
          artifacts.resolveArtifact,
        ),
        options.signal,
      ),
  });
}
