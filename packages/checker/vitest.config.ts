import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/testing/**"],
      /**
       * Pinned at the measured figure, floored — a ratchet against regression,
       * not a target. Measured without network egress, so the DNS tests behind
       * the reachability guard were skipped; with egress these only go up.
       */
      thresholds: { statements: 76, branches: 65, functions: 96, lines: 76 },
    },
  },
});
