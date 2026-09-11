import {
  inspectClaudeHistory,
  createClaudeHistoryConsumer,
} from "./claude-history.js";
import { followJsonlSource } from "./follow-jsonl.js";
import { claudeFamilyFollower } from "./claude-family.js";
import {
  publishNativeRecording,
  type NativePublishOptions,
} from "./publish-native.js";
export type ClaudePublishOptions = NativePublishOptions & {
  includeChildren?: boolean;
};
/** Follow a native Claude file without changing the agent or its retained history. */
export async function publishClaudeRecording(
  options: ClaudePublishOptions,
): Promise<void> {
  const manifest = await inspectClaudeHistory(
    options.sourcePath,
    options.signal,
    "defer",
  );
  await publishNativeRecording(options, {
    agent: "claude",
    nativeSessionId: manifest.nativeSessionId,
    converterVersion: options.includeChildren
      ? "claude-history-4-family-1"
      : "claude-history-4",
    recordFormat: "native-jsonl",
    follow: async (context) => {
      const consumer = await createClaudeHistoryConsumer(
        manifest,
        context.journal,
        context.secrets,
        context.artifacts.resolveInline,
        {
          ...(context.artifacts.resolveRemote
            ? { resolveRemote: context.artifacts.resolveRemote }
            : {}),
        },
      );
      await followJsonlSource(context.sourcePath, {
        ...(options.includeChildren
          ? { onScan: claudeFamilyFollower(manifest.nativeSessionId, context) }
          : {}),
        ...(options.finishRequested
          ? { finishRequested: options.finishRequested }
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
