import {
  inspectOpenCodeHistory,
  captureOpenCodeHistory,
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
    converterVersion: "opencode-export-2",
    source,
    capture: (journal, secrets, artifacts) =>
      captureOpenCodeHistory(
        options.sourcePath,
        source,
        journal,
        secrets,
        options.signal,
        artifacts,
      ),
  });
}
