import { discoverCodexFamily } from "./codex-family.js";
import { CodexCapture } from "./codex.js";
import { inspectCodexHistory, captureCodexHistory } from "./codex-history.js";
import {
  type FrozenSourceSnapshot,
  snapshotTail,
  snapshotChild,
  assertSnapshotChildren,
} from "./frozen-source.js";
import {
  importNativeRecording,
  type NativeImportOptions,
} from "./import-native.js";
export type CodexImportOptions = NativeImportOptions & {
  familyRoot?: string;
  snapshot?: FrozenSourceSnapshot;
};
export async function importCodexRecording(options: CodexImportOptions) {
  const tail = snapshotTail(options.snapshot);
  const source = await inspectCodexHistory(
    options.sourcePath,
    options.signal,
    tail,
    options.snapshot?.rootThrough,
  );
  const family: {
    sourcePath: string;
    nativeAgent: string;
    manifest: Awaited<ReturnType<typeof inspectCodexHistory>>;
  }[] = [];
  if (options.familyRoot) {
    const threads = await discoverCodexFamily(
      options.familyRoot,
      source.nativeSessionId,
      options.sourcePath,
      options.signal,
    );
    if (source.nativeThreadIds[0] !== source.nativeSessionId)
      throw new Error("Codex family import requires a root rollout");
    for (const [thread, candidate] of threads) {
      if (thread === source.nativeSessionId) continue;
      const frozen = snapshotChild(options.snapshot, thread);
      if (!frozen.include) continue;
      const sourcePath = candidate.source!;
      const manifest = await inspectCodexHistory(
        sourcePath,
        options.signal,
        tail,
        frozen.through,
      );
      if (
        manifest.nativeSessionId !== source.nativeSessionId ||
        manifest.nativeThreadIds[0] !== thread ||
        manifest.nativeThreadParents?.[thread] !==
          candidate.parentNativeThreadId
      )
        throw new Error("Codex child rollout has conflicting identity");
      const ancestors = new Set<string>();
      let ancestor = candidate.parentNativeThreadId;
      while (ancestor) {
        ancestors.add(ancestor);
        if (ancestor === source.nativeSessionId) break;
        ancestor = threads.get(ancestor)?.parentNativeThreadId;
      }
      if (
        manifest.nativeThreadIds.some(
          (id) => id !== thread && !ancestors.has(id),
        )
      )
        throw new Error(
          "Codex child rollout contains unrelated thread metadata",
        );
      if (
        !manifest.structuredItems &&
        manifest.legacyRecords &&
        manifest.nativeThreadIds.length > 1
      )
        throw new Error(
          "Mixed-thread legacy Codex history requires explicit reconciliation",
        );
      family.push({ sourcePath, nativeAgent: thread, manifest });
    }
    family.sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent));
    assertSnapshotChildren(
      options.snapshot,
      family.map((child) => child.nativeAgent),
    );
  }
  return importNativeRecording(options, {
    agent: "codex",
    converterVersion: options.familyRoot
      ? "codex-history-4-family-import-1"
      : "codex-history-4",
    ...(options.familyRoot
      ? {
          familySources: family.map((child) => ({
            sourcePath: child.sourcePath,
            nativeAgent: child.nativeAgent,
            boundary: child.manifest.boundary,
          })),
        }
      : {}),
    source,
    capture: async (journal, secrets, artifacts) => {
      const report = await captureCodexHistory(
        options.sourcePath,
        source,
        new CodexCapture(
          journal,
          secrets,
          source.createdAt,
          artifacts.resolveArtifact,
          undefined,
          artifacts,
        ),
        options.signal,
      );
      const children = [];
      for (const child of family)
        children.push({
          nativeAgent: child.nativeAgent,
          report: await captureCodexHistory(
            child.sourcePath,
            child.manifest,
            new CodexCapture(
              journal,
              secrets,
              child.manifest.createdAt,
              artifacts.resolveArtifact,
              child.nativeAgent,
              artifacts,
            ),
            options.signal,
            { childThreadId: child.nativeAgent },
          ),
        });
      return options.familyRoot ? { ...report, children } : report;
    },
  });
}
