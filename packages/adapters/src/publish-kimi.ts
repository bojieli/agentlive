import {
  inspectKimiHistory,
  createKimiHistoryConsumer,
} from "./kimi-history.js";
import { followJsonlSource } from "./follow-jsonl.js";
import { kimiFamilyRoot, kimiFamilyFollower } from "./kimi-family.js";
import {
  publishNativeRecording,
  type NativePublishOptions,
} from "./publish-native.js";
export type KimiPublishOptions = NativePublishOptions & {
  nativeIdentity?: { nativeSessionId: string; agentId: string };
  includeChildren?: boolean;
};
/** Follow one wire log or explicitly coordinate the native session's agent logs. */
export async function publishKimiRecording(
  options: KimiPublishOptions,
): Promise<void> {
  const manifest = await inspectKimiHistory(
    options.sourcePath,
    options.signal,
    options.nativeIdentity,
    "defer",
  );
  const familyRoot = options.includeChildren
    ? kimiFamilyRoot(options.sourcePath, manifest.nativeSessionId)
    : undefined;
  if (familyRoot && manifest.agentId !== "main")
    throw new Error("Kimi family capture must bind the main agent identity");
  await publishNativeRecording(options, {
    agent: "kimi",
    nativeSessionId: manifest.nativeSessionId,
    converterVersion: `kimi-history-4-${manifest.agentId}${options.includeChildren ? "-family-1" : ""}`,
    recordFormat: "native-wire-jsonl",
    follow: async (context) => {
      const consumer = await createKimiHistoryConsumer(
        manifest,
        context.journal,
        context.secrets,
        context.artifacts.resolveArtifact,
        { mediaResolvers: context.artifacts },
      );
      await followJsonlSource(context.sourcePath, {
        ...(options.finishRequested
          ? { finishRequested: options.finishRequested }
          : {}),
        ...(familyRoot
          ? {
              onScan: kimiFamilyFollower(
                familyRoot,
                manifest.nativeSessionId,
                context,
              ),
            }
          : {}),
        signal: context.signal,
        commit: async (record) => {
          await consumer.accept(record);
          await context.onRecordCommitted(record.cursor);
        },
        onCaughtUp: context.onCaughtUp,
      });
    },
  });
}
