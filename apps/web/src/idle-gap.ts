/** Spend recorded-time budget on one gap. The clock jumps only after its capped wait. */
export function spendIdleGap(
  time: number,
  anchor: number,
  next: number,
  budget: number,
  cap: number,
) {
  const remaining = Math.max(0, Math.min(next - anchor, cap) - (time - anchor));
  if (budget < remaining)
    return { time: time + budget, anchor, budget: 0, admitted: false };
  return {
    time: next,
    anchor: next,
    budget: budget - remaining,
    admitted: true,
  };
}
export function validateIdleCap(cap: number | undefined) {
  if (cap !== undefined && (!Number.isFinite(cap) || cap < 0))
    throw new RangeError("Invalid idle gap cap");
}
