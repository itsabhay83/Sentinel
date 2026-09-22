import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * Pinned here rather than inherited from the developer's root `.env`, so
     * the Zod env schema validates identically on every machine and in CI. No
     * test opens a socket. `LOG_LEVEL: fatal` keeps pino quiet, and an empty
     * `RESEND_API_KEY` selects the stdout email transport.
     */
    env: {
      DATABASE_URL: "postgres://sentinel:sentinel@127.0.0.1:5432/sentinel_test",
      REDIS_URL: "redis://127.0.0.1:6379",
      ENCRYPTION_KEY: "0".repeat(64),
      BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      RESEND_API_KEY: "",
      LOG_LEVEL: "fatal",
      METRICS_ENABLED: "true",
      ALERT_MAX_DELIVERY_ATTEMPTS: "5",
      CHECK_JOB_ATTEMPTS: "3",
      QUEUE_MAX_DEPTH: "10",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        "src/index.ts",
        "src/logger.ts",
        "src/redis.ts",
        "src/sentry.ts",
        // Installs SIGINT/SIGTERM/uncaughtException handlers on the process and
        // ends every path in process.exit — exercising it would take the vitest
        // worker with it and leak handlers into unrelated test files.
        "src/shutdown.ts",
      ],
      /** Pinned at the measured figure, floored — a ratchet against regression, not a target. */
      thresholds: { statements: 97, branches: 96, functions: 98, lines: 97 },
    },
  },
});
