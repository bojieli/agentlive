import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectOpenCodeHistory,
  type OpenCodeHistoryManifest,
} from "./opencode-history.js";
/** Read native per-session exports, retaining only bounded identity/hash metadata. */
export async function inspectOpenCodeImportFamily(
  root: string,
  sourcePath: string,
  source: OpenCodeHistoryManifest,
  signal: AbortSignal,
) {
  const exports = new Map<
    string,
    { sourcePath: string; manifest: OpenCodeHistoryManifest }
  >([
    [
      source.nativeSessionId,
      { sourcePath: resolve(sourcePath), manifest: source },
    ],
  ]);
  let scanned = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (++scanned > 10000)
        throw new Error("OpenCode export directory exceeds discovery limit");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("OpenCode family exports cannot use symbolic links");
      if (entry.isDirectory()) {
        if (depth >= 8)
          throw new Error("OpenCode export directory exceeds eight levels");
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".json") || path === resolve(sourcePath))
        continue;
      if (!entry.isFile())
        throw new Error("OpenCode family export must be a regular file");
      if (exports.size >= 200)
        throw new Error("OpenCode family exceeds 200 exports");
      const manifest = await inspectOpenCodeHistory(path, signal);
      if (exports.has(manifest.nativeSessionId))
        throw new Error("OpenCode family has duplicate session exports");
      exports.set(manifest.nativeSessionId, { sourcePath: path, manifest });
    }
  };
  await visit(resolve(root), 0);
  const family = [];
  for (const [id, entry] of exports) {
    if (id === source.nativeSessionId) continue;
    const seen = new Set([id]);
    let parent = entry.manifest.parentNativeSessionId;
    while (parent !== source.nativeSessionId) {
      if (!parent || seen.has(parent) || seen.size >= 8)
        throw new Error(
          "OpenCode family exports have missing, unrelated, cyclic or excessively deep lineage",
        );
      seen.add(parent);
      parent = exports.get(parent)?.manifest.parentNativeSessionId;
    }
    family.push({ ...entry, nativeAgent: id });
  }
  family.sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent));
  return family;
}
