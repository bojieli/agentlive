/** Keep at most one focused offscreen row mounted while the viewport changes. */
export function activityRange(
  range: {
    startIndex: number;
    endIndex: number;
    overscan: number;
    count: number;
  },
  focused: number,
): number[] {
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  const indices: number[] = [];
  for (let index = start; index <= end; index++) indices.push(index);
  if (focused >= 0 && focused < range.count && !indices.includes(focused))
    indices.push(focused);
  return indices.sort((a, b) => a - b);
}
