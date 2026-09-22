import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * Pinned here rather than inherited from the developer's root `.env`, so the
     * retry ladder's attempt count is the same number on every machine and in CI.
     * No test opens a socket — these only have to satisfy the env schema.
     */
    env: {
      DATABASE_URL: "postgres://sentinel:sentinel@127.0.0.1:5432/sentinel_test",
      REDIS_URL: "redis://127.0.0.1:6379",
      ENCRYPTION_KEY: "0".repeat(64),
      BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      DB_MAX_RETRIES: "3",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/**", "src/schema/**", "src/migrate.ts"],
      /** Pinned at the measured figure, floored — a ratchet against regression, not a target. */
      thresholds: { statements: 89, branches: 94, functions: 75, lines: 89 },
    },
  },
});
