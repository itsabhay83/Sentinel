import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/server.ts", "src/env.ts"],
      /** Pinned at the measured figure, floored — a ratchet against regression, not a target. */
      thresholds: { statements: 99, branches: 96, functions: 100, lines: 99 },
    },
  },
});
