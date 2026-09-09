import {
  CodexCapture,
  type CodexArtifactResolver,
  type CodexCaptureSink,
} from "./codex.js";
import {
  createCodexHistoryConsumer,
  inspectCodexHistory,
} from "./codex-history.js";
import { followJsonlSource } from "./follow-jsonl.js";
/** Full retained backfill on each attach reconstructs converter state; journal source keys deduplicate it. */
export async function followCodexHistory(options: {
  recordFormat?: "structured" | "legacy";
  sourcePath: string;
  journal: CodexCaptureSink;
  signal: AbortSignal;
  secrets?: readonly string[];
  resolveArtifact?: CodexArtifactResolver;
  pollMs?: number;
  onCaughtUp?: () => Promise<void>;
}): Promise<void> {
  const manifest = await inspectCodexHistory(
    options.sourcePath,
    options.signal,
    "defer",
  );
  if (manifest.nativeSessionId !== options.journal.identity.nativeSessionId)
    throw new Error("Source does not belong to the bound publisher session");
  // The transport selects the native record format; an empty history cannot reveal it.
  if (options.recordFormat === "legacy") {
    if (manifest.structuredItems)
      throw new Error(
        "Structured items conflict with the selected legacy source format",
      );
  } else manifest.structuredItems = Math.max(1, manifest.structuredItems);
  const capture = new CodexCapture(
    options.journal,
    options.secrets ?? [],
    manifest.createdAt,
    options.resolveArtifact,
  );
  const consumer = await createCodexHistoryConsumer(manifest, capture);
  await followJsonlSource(options.sourcePath, {
    signal: options.signal,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    commit: consumer.accept,
    onCaughtUp: async () => {
      await options.onCaughtUp?.();
    },
  });
}
