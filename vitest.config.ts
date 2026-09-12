import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Process- and disk-heavy suites need headroom on a slow shared runner;
    // a genuinely hung test still fails, just later.
    testTimeout: 30_000,
    // Many suites drive real filesystem stores, kernel locks and child
    // processes, so each worker uses well over one core. Scaling to the
    // machine keeps a 4-vCPU CI runner from oversubscribing while a large
    // development machine still finishes in a few minutes; without this,
    // suites fail on contention rather than on behaviour.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 3)),
  },
});
