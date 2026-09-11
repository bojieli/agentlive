/**
 * Live-binding migration imports a frozen prefix of native files that may still grow.
 * Snapshot reads defer incomplete trailing lines; saved offsets make retries exact.
 */
export interface FrozenSourceSnapshot {
  /** Root boundary saved by an earlier attempt; omitted to freeze at the last complete line. */
  rootThrough?: number;
  /** Saved child boundaries; unlisted children are excluded. Omitted to include current children. */
  children?: Readonly<Record<string, number>>;
}

export const snapshotTail = (snapshot: FrozenSourceSnapshot | undefined) =>
  snapshot ? ("defer" as const) : ("parse" as const);

/** Whether a discovered child belongs to the frozen family, and its saved bound. */
export function snapshotChild(
  snapshot: FrozenSourceSnapshot | undefined,
  nativeAgent: string,
): { include: boolean; through?: number } {
  if (!snapshot?.children) return { include: true };
  if (!Object.hasOwn(snapshot.children, nativeAgent)) return { include: false };
  return { include: true, through: snapshot.children[nativeAgent]! };
}

export function assertSnapshotChildren(
  snapshot: FrozenSourceSnapshot | undefined,
  found: Iterable<string>,
) {
  if (!snapshot?.children) return;
  const present = new Set(found);
  for (const child of Object.keys(snapshot.children))
    if (!present.has(child))
      throw new Error("A frozen family child source is no longer available");
}
