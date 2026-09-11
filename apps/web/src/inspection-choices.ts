import { ProtocolError } from "@agentlive/protocol";
export const MAX_EXPANSIONS = 128;
export function expansionKey(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 2048)
    throw new ProtocolError("invalid_request", "Invalid disclosure choice");
  return value;
}
export function expansionChoices(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EXPANSIONS)
    throw new ProtocolError("corrupt_storage", "Invalid disclosure choices");
  const keys = value.map(expansionKey);
  if (new Set(keys).size !== keys.length)
    throw new ProtocolError("corrupt_storage", "Duplicate disclosure choice");
  return keys;
}
/** Keep the most recently opened disclosures within a fixed metadata bound. */
export function changeExpansion(
  previous: readonly string[],
  key: string,
  expanded: boolean,
): string[] {
  expansionKey(key);
  const next = previous.filter((item) => item !== key);
  if (expanded) next.push(key);
  return next.slice(-MAX_EXPANSIONS);
}

export type TextPosition = number | "latest";
export type TextPageChoice = readonly [string, TextPosition];
export function textPosition(value: unknown): TextPosition {
  if (value === "latest") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError("invalid_request", "Invalid text page position");
  return value;
}
export function textPageChoices(value: unknown): TextPageChoice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128)
    throw new ProtocolError("corrupt_storage", "Invalid text page choices");
  const entries = value.map((entry): TextPageChoice => {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw new ProtocolError("corrupt_storage", "Invalid text page choice");
    return [expansionKey(entry[0]), textPosition(entry[1])];
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new ProtocolError("corrupt_storage", "Duplicate text page choice");
  return entries;
}
export function changeTextPage(
  previous: readonly TextPageChoice[],
  key: string,
  page: TextPosition,
): TextPageChoice[] {
  return [
    ...previous.filter(([id]) => id !== key),
    [expansionKey(key), textPosition(page)] as const,
  ].slice(-128);
}
