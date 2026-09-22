import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke suite. It drives the real application over HTTP — nothing
 * here is stubbed — so the stack has to be running before `pnpm test:e2e`.
 *
 * `E2E_BASE_URL` exists so CI (and anyone running a second stack on another
 * port) can point the same specs somewhere else without editing them.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3010";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // CI runs one worker so the rate-limit spec's request budget is never shared
  // with a parallel worker, which would make the 429 arrive at an unstable
  // request number.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Report and traces land at the repo root rather than inside e2e/, which is
  // where .gitignore and the CI artifact upload expect them.
  outputDir: "../test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "setup",
      testDir: "./support",
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
