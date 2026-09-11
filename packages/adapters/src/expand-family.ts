import { canonicalJson } from "@agentlive/protocol";
/** Scope expansion preserves the main converter and every other pinned policy. */
export function isFileFamilyExpansion(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const versions: Record<string, string> = {
    "claude-history-4": "claude-history-4-family-1",
    "kimi-history-4-main": "kimi-history-4-main-family-1",
    "codex-history-4": "codex-history-4-family-1",
  };
  if (
    typeof previous.converterVersion !== "string" ||
    versions[previous.converterVersion] !== next.converterVersion ||
    previous.familyRoot !== undefined
  )
    return false;
  const upgraded = {
    ...previous,
    converterVersion: next.converterVersion,
    ...(next.familyRoot !== undefined ? { familyRoot: next.familyRoot } : {}),
  };
  return canonicalJson(upgraded) === canonicalJson(next);
}
