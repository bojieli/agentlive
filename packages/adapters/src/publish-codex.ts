import { inspectCodexHistory } from "./codex-history.js";
import { followCodexHistory } from "./follow-codex.js";
import { codexFamilyFollower } from "./codex-family.js";
import {
  publishNativeRecording,
  type NativePublishOptions,
} from "./publish-native.js";
export interface CodexPublishOptions extends NativePublishOptions {
  recordFormat?: "structured" | "legacy";
  familyRoot?: string;
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
    ...(options.familyRoot ? { familyRoot: options.familyRoot } : {}),
    converterVersion: options.familyRoot
      ? "codex-history-4-family-1"
      : "codex-history-4",
    recordFormat: options.recordFormat ?? "structured",
    follow: (context) =>
      followCodexHistory({
        ...context,
        ...(options.familyRoot
          ? {
              onScan: codexFamilyFollower(
                options.familyRoot,
                source.nativeSessionId,
                context,
                options.recordFormat ?? "structured",
              ),
            }
          : {}),
        ...(options.finishRequested
          ? { finishRequested: options.finishRequested }
          : {}),
        recordFormat: options.recordFormat ?? "structured",
        resolveArtifact: context.artifacts.resolveArtifact,
        mediaResolvers: context.artifacts,
      }),
  });
}
