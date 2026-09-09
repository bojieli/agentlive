import {
  inspectKimiHistory,
  createKimiHistoryConsumer,
} from "./kimi-history.js";
import { followJsonlSource } from "./follow-jsonl.js";
import {
  publishNativeRecording,
  type NativePublishOptions,
} from "./publish-native.js";
export type KimiPublishOptions = NativePublishOptions & {
  nativeIdentity?: { nativeSessionId: string; agentId: string };
};
/** Follow one Kimi agent wire log; multi-agent session merging is a separate coordinator. */
export async function publishKimiRecording(
  options: KimiPublishOptions,
): Promise<void> {
  const manifest = await inspectKimiHistory(
    options.sourcePath,
    options.signal,
    options.nativeIdentity,
    "defer",
  );
  await publishNativeRecording(options, {
    agent: "kimi",
    nativeSessionId: manifest.nativeSessionId,
    converterVersion: `kimi-history-3-${manifest.agentId}`,
    recordFormat: "native-wire-jsonl",
    follow: async (context) => {
      const consumer = await createKimiHistoryConsumer(
        manifest,
        context.journal,
        context.secrets,
        context.artifacts.resolveArtifact,
      );
      await followJsonlSource(context.sourcePath, {
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
