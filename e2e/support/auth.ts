import { expect, type Locator, type Page } from "@playwright/test";

import { DEMO_EMAIL, DEMO_PASSWORD } from "./fixtures";

/**
 * SELECTOR TRAP — READ BEFORE "SIMPLIFYING" ANY LOCATOR IN THIS SUITE.
 *
 * `apps/web/src/app/(app)/layout.tsx` renders `<Sidebar>` before `{children}`,
 * and the sidebar's footer is `<form action={logout}><button type="submit">Sign
 * out</button></form>`. So on every authenticated page the FIRST
 * `button[type="submit"]` in the DOM is "Sign out", not the button the page is
 * about.
 *
 * A locator like `page.locator('button[type=submit]').first()` therefore signs
 * the user out and makes the app look like it drops sessions on form submit —
 * a phantom bug that has already cost one QA pass an hour. Every button in this
 * suite is addressed by role + accessible name, or scoped to its own `<form>`.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");

  await page.getByLabel("Email", { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(signOutButton(page)).toBeVisible();
}

/**
 * The sidebar's logout button, and the suite's marker for "this page rendered
 * inside the authenticated shell".
 *
 * `exact` is load-bearing: /settings/security also offers "Sign out everywhere
 * else", and a substring match resolves to both buttons.
 */
export function signOutButton(page: Page): Locator {
  return page.getByRole("button", { name: "Sign out", exact: true });
}
