import { join, resolve } from "node:path";
import { discoverNativeSessions } from "./discovery.js";
import { kimiFamilyRoot } from "./kimi-family.js";
import { inspectKimiHistory, captureKimiHistory } from "./kimi-history.js";
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
export type KimiImportOptions = NativeImportOptions & {
  includeChildren?: boolean;
  nativeIdentity?: { nativeSessionId: string; agentId: string };
  snapshot?: FrozenSourceSnapshot;
};
export async function importKimiRecording(options: KimiImportOptions) {
  const tail = snapshotTail(options.snapshot);
  const source = await inspectKimiHistory(
    options.sourcePath,
    options.signal,
    options.nativeIdentity,
    tail,
    options.snapshot?.rootThrough,
  );
  const family: {
    sourcePath: string;
    nativeAgent: string;
    manifest: Awaited<ReturnType<typeof inspectKimiHistory>>;
  }[] = [];
  if (options.includeChildren) {
    if (source.agentId !== "main")
      throw new Error("Kimi family import requires the main agent identity");
    const root = kimiFamilyRoot(options.sourcePath, source.nativeSessionId);
    const found = await discoverNativeSessions({
      agent: "kimi",
      root,
      nativeSessionId: source.nativeSessionId,
      limit: 200,
      signal: options.signal,
    });
    if (found.truncated || found.skipped)
      throw new Error("Kimi family import discovery is incomplete");
    const agents = new Set<string>();
    for (const candidate of found.sessions) {
      const agent = candidate.nativeAgent;
      if (
        !agent ||
        candidate.source !== join(root, "agents", agent, "wire.jsonl") ||
        agents.has(agent)
      )
        throw new Error(
          "Kimi family import has ambiguous identity or unexpected layout",
        );
      agents.add(agent);
      if (agent === "main") {
        if (candidate.source !== resolve(options.sourcePath))
          throw new Error("Kimi family import root changed");
        continue;
      }
      const frozen = snapshotChild(options.snapshot, agent);
      if (!frozen.include) continue;
      const manifest = await inspectKimiHistory(
        candidate.source,
        options.signal,
        undefined,
        tail,
        frozen.through,
      );
      if (
        manifest.nativeSessionId !== source.nativeSessionId ||
        manifest.agentId !== agent
      )
        throw new Error("Kimi family import child identity changed");
      family.push({
        sourcePath: candidate.source,
        nativeAgent: agent,
        manifest,
      });
    }
    if (!agents.has("main"))
      throw new Error("Kimi family import main log disappeared");
    family.sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent));
    assertSnapshotChildren(
      options.snapshot,
      family.map((child) => child.nativeAgent),
    );
  }
  return importNativeRecording(options, {
    agent: "kimi",
    converterVersion: `kimi-history-4-${source.agentId}${options.includeChildren ? "-family-import-1" : ""}`,
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
      const report = await captureKimiHistory(
        options.sourcePath,
        source,
        journal,
        secrets,
        options.signal,
        artifacts.resolveArtifact,
        { mediaResolvers: artifacts },
      );
      const children = [];
      for (const child of family) {
        children.push({
          nativeAgent: child.nativeAgent,
          report: await captureKimiHistory(
            child.sourcePath,
            child.manifest,
            journal,
            secrets,
            options.signal,
            artifacts.resolveArtifact,
            { childLog: true, mediaResolvers: artifacts },
          ),
        });
      }
      return options.includeChildren ? { ...report, children } : report;
    },
  });
}
