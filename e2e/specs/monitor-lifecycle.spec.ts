import { expect, test } from "@playwright/test";

import { signIn, signOutButton } from "../support/auth";
import { CSRF_FIELD, CSRF_TOKEN_PATTERN, MONITOR_DETAIL_PATTERN } from "../support/fixtures";

/**
 * The highest-value path in the app: sign in, mint a CSRF token, drive a Next
 * server action, land on the created resource, then remove it again.
 *
 * Server actions cannot be exercised by a plain POST — a fetch to the page
 * route just returns page HTML — so this has to go through a real browser.
 */
let createdMonitorPath: string | null = null;

test.afterEach(async ({ page }) => {
  // Safety net. The test deletes its own monitor as its last step; this only
  // fires when an earlier assertion aborted the test, so a failed run still
  // leaves the seeded database exactly as it found it.
  const orphan = createdMonitorPath;
  createdMonitorPath = null;
  if (orphan === null) return;

  await page.goto(orphan);
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("creates a monitor through the UI and removes it again", async ({ page }) => {
  await signIn(page);

  await page.goto("/monitors/new");

  // `<CsrfInput />` can only render a value the middleware already put in the
  // cookie, so the hidden field's presence is the end-to-end proof that the
  // double-submit pair was established for this browsing context.
  const csrfField = page.locator(`form input[name="${CSRF_FIELD}"]`);
  await expect(csrfField).toHaveCount(1);
  await expect(csrfField).toHaveValue(CSRF_TOKEN_PATTERN);

  const name = `e2e-${Date.now()}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Target", { exact: true }).fill("https://example.com/");

  // Role + name, never `button[type=submit]` — see support/auth.ts.
  await page.getByRole("button", { name: "Create monitor" }).click();

  await expect(page).toHaveURL(MONITOR_DETAIL_PATTERN);
  const monitorPath = new URL(page.url()).pathname;
  createdMonitorPath = monitorPath;

  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  // The session has to survive the action round-trip. If it did not, the app
  // layout would have bounced this navigation to /login instead.
  await expect(signOutButton(page)).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  createdMonitorPath = null;

  const afterDelete = await page.goto(monitorPath);
  expect(afterDelete?.status()).toBe(404);
});
