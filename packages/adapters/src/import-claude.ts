import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { idSchema } from "@agentlive/protocol";
import { readJsonlSource } from "./jsonl.js";
import {
  inspectClaudeHistory,
  captureClaudeHistory,
} from "./claude-history.js";
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
export type ClaudeImportOptions = NativeImportOptions & {
  includeChildren?: boolean;
  snapshot?: FrozenSourceSnapshot;
};
export async function importClaudeRecording(options: ClaudeImportOptions) {
  const tail = snapshotTail(options.snapshot);
  const source = await inspectClaudeHistory(
    options.sourcePath,
    options.signal,
    tail,
    options.snapshot?.rootThrough,
  );
  const family: {
    sourcePath: string;
    nativeAgent: string;
    manifest: Awaited<ReturnType<typeof inspectClaudeHistory>>;
  }[] = [];
  if (options.includeChildren) {
    idSchema.parse(source.nativeSessionId);
    // An explicitly supplied child path must not be promoted to the root.
    for await (const record of readJsonlSource(options.sourcePath, {
      through: source.boundary.offset,
      tail: "parse",
      signal: options.signal,
    })) {
      if ((record.value as { isSidechain?: unknown }).isSidechain === true)
        throw new Error("Claude family import requires a main transcript");
    }
    const directory = join(
      dirname(options.sourcePath),
      source.nativeSessionId,
      "subagents",
    );
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entries) {
      let scanned = 0;
      for await (const entry of entries) {
        options.signal.throwIfAborted();
        if (++scanned > 10000)
          throw new Error("Claude subagent directory exceeds discovery limit");
        if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl"))
          continue;
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error("Claude subagent source must be a regular file");
        if (family.length >= 199)
          throw new Error("Claude family exceeds 199 subagent logs");
        const nativeAgent = idSchema.parse(entry.name.slice(6, -6));
        const frozen = snapshotChild(options.snapshot, nativeAgent);
        if (!frozen.include) continue;
        const sourcePath = join(directory, entry.name);
        const manifest = await inspectClaudeHistory(
          sourcePath,
          options.signal,
          tail,
          frozen.through,
        );
        if (manifest.nativeSessionId !== source.nativeSessionId)
          throw new Error("Claude subagent belongs to another session");
        family.push({ sourcePath, nativeAgent, manifest });
      }
    }
    family.sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent));
    assertSnapshotChildren(
      options.snapshot,
      family.map((child) => child.nativeAgent),
    );
  }
  return importNativeRecording(options, {
    agent: "claude",
    converterVersion: options.includeChildren
      ? "claude-history-4-family-import-1"
      : "claude-history-4",
    ...(options.includeChildren
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
      const report = await captureClaudeHistory(
        options.sourcePath,
        source,
        journal,
        secrets,
        options.signal,
        artifacts.resolveInline,
        {
          ...(artifacts.resolveRemote
            ? { resolveRemote: artifacts.resolveRemote }
            : {}),
        },
      );
      const children = [];
      for (const child of family)
        children.push({
          nativeAgent: child.nativeAgent,
          report: await captureClaudeHistory(
            child.sourcePath,
            child.manifest,
            journal,
            secrets,
            options.signal,
            artifacts.resolveInline,
            {
              childAgentId: child.nativeAgent,
              ...(artifacts.resolveRemote
                ? { resolveRemote: artifacts.resolveRemote }
                : {}),
            },
          ),
        });
      return options.includeChildren ? { ...report, children } : report;
    },
  });
}
