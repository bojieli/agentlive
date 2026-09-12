import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { idSchema } from "@agentlive/protocol";
import { discoverNativeSessions } from "./discovery.js";
import { discoverCodexFamily } from "./codex-family.js";
import { kimiFamilyRoot } from "./kimi-family.js";

/**
 * Where each file agent's family importer would find its child sources right now,
 * keyed by the child identity the import boundary pins. Layout mirrors the importers
 * in `import-claude`, `import-codex` and `import-kimi`; a child missing from the
 * result is one those importers would refuse to freeze again.
 *
 * This is a locator, not a validator: it neither reads a child's records nor checks
 * that a child still belongs to the session. Callers verify the pinned prefix.
 */
export async function locateFileFamilySources(options: {
  agent: "claude" | "codex" | "kimi";
  sourcePath: string;
  nativeSessionId: string;
  /** Codex only: the rollout root its family discovery scans. */
  familyRoot?: string;
  signal: AbortSignal;
}): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (options.agent === "claude") {
    const directory = join(
      dirname(options.sourcePath),
      idSchema.parse(options.nativeSessionId),
      "subagents",
    );
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return found;
    }
    let scanned = 0;
    for await (const entry of entries) {
      options.signal.throwIfAborted();
      if (++scanned > 10000)
        throw new Error("Claude subagent directory exceeds discovery limit");
      if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl"))
        continue;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      found.set(entry.name.slice(6, -6), join(directory, entry.name));
    }
    return found;
  }
  if (options.agent === "kimi") {
    const root = kimiFamilyRoot(options.sourcePath, options.nativeSessionId);
    const sessions = await discoverNativeSessions({
      agent: "kimi",
      root,
      nativeSessionId: options.nativeSessionId,
      limit: 200,
      signal: options.signal,
    });
    for (const candidate of sessions.sessions) {
      const agent = candidate.nativeAgent;
      if (!agent || agent === "main" || !candidate.source) continue;
      found.set(agent, candidate.source);
    }
    return found;
  }
  if (options.familyRoot === undefined)
    throw new Error("Codex family sources require the rollout root");
  const threads = await discoverCodexFamily(
    options.familyRoot,
    options.nativeSessionId,
    options.sourcePath,
    options.signal,
  );
  for (const [thread, candidate] of threads) {
    if (thread === options.nativeSessionId || !candidate.source) continue;
    found.set(thread, candidate.source);
  }
  return found;
}
