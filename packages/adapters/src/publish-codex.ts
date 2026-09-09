import { inspectCodexHistory } from "./codex-history.js";
import { followCodexHistory } from "./follow-codex.js";
import {
  publishNativeRecording,
  type NativePublishOptions,
} from "./publish-native.js";
export interface CodexPublishOptions extends NativePublishOptions {
  recordFormat?: "structured" | "legacy";
}
export async function publishCodexRecording(
  options: CodexPublishOptions,
): Promise<void> {
  const source = await inspectCodexHistory(
    options.sourcePath,
    options.signal,
    "defer",
  );
  await publishNativeRecording(options, {
    agent: "codex",
    nativeSessionId: source.nativeSessionId,
    converterVersion: "codex-history-3",
    recordFormat: options.recordFormat ?? "structured",
    follow: (context) =>
      followCodexHistory({
        ...context,
        recordFormat: options.recordFormat ?? "structured",
        resolveArtifact: context.artifacts.resolveArtifact,
      }),
  });
}
