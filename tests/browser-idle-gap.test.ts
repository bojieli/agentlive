import { expect, it } from "vitest";
import { spendIdleGap } from "../apps/web/src/idle-gap.js";
it("spends only the remaining capped wait and carries excess into the next gap", () => {
  expect(spendIdleGap(400, 0, 10000, 200, 1000)).toEqual({
    time: 600,
    anchor: 0,
    budget: 0,
    admitted: false,
  });
  expect(spendIdleGap(600, 0, 10000, 900, 1000)).toEqual({
    time: 10000,
    anchor: 10000,
    budget: 500,
    admitted: true,
  });
  expect(spendIdleGap(10000, 10000, 10200, 500, 1000)).toEqual({
    time: 10200,
    anchor: 10200,
    budget: 300,
    admitted: true,
  });
});
it("retains ties and reevaluates changed caps without committing skipped time early", () => {
  expect(spendIdleGap(10000, 10000, 10000, 0, 0).admitted).toBe(true);
  expect(spendIdleGap(500, 0, 10000, 0, 0).time).toBe(10000);
  expect(spendIdleGap(500, 0, 10000, 500, 5000)).toEqual({
    time: 1000,
    anchor: 0,
    budget: 0,
    admitted: false,
  });
});
