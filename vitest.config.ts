import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    // Many suites drive real filesystem stores, kernel locks and child
    // processes. Unbounded parallelism starves them of disk and makes
    // timing assertions fail on contention rather than on behaviour, so
    // bound the workers: the suite stays deterministic under load and still
    // finishes in a few minutes.
    maxWorkers: 4,
  },
});
