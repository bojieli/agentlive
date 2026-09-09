import { inspectKimiHistory, captureKimiHistory } from "./kimi-history.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
export type KimiImportOptions = NativeImportOptions & {
  nativeIdentity?: { nativeSessionId: string; agentId: string };
};
export async function importKimiRecording(options: KimiImportOptions) {
  const source = await inspectKimiHistory(
    options.sourcePath,
    options.signal,
    options.nativeIdentity,
  );
  return importNativeRecording(options, {
    agent: "kimi",
    converterVersion: `kimi-history-2-${source.agentId}`,
    source,
    capture: (journal, secrets) =>
      captureKimiHistory(
        options.sourcePath,
        source,
        journal,
        secrets,
        options.signal,
      ),
  });
}
