import { clerk } from "@clerk/testing/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

import { DEMO_EMAIL } from "./fixtures";

/**
 * SELECTOR TRAP — READ BEFORE "SIMPLIFYING" ANY LOCATOR IN THIS SUITE.
 *
 * `apps/web/src/components/shell.tsx` renders the sidebar before `{children}`,
 * and its footer is Clerk's `<SignOutButton>` wrapping a plain `<button>` that
 * reads "Sign out". So on every authenticated page the FIRST button in the DOM
 * is "Sign out", not the button the page is about.
 *
 * A positional locator like `page.locator("button").first()` therefore signs
 * the user out and makes the app look like it drops sessions on form submit —
 * a phantom bug that has already cost one QA pass an hour. Every button in this
 * suite is addressed by role + accessible name, or scoped to its own `<form>`.
 */

/**
 * Signs in through Clerk's client SDK rather than its sign-in form.
 *
 * The form is deliberately not driven here. Clerk renders `<SignIn />` as a
 * multi-step widget (identifier, then factor-one on its own sub-route) behind
 * Turnstile bot protection, so filling fields by label is both brittle and
 * liable to be challenged. `clerk.signIn` mints a sign-in ticket through the
 * Backend API and hands it to the loaded SDK, which is the flow Clerk supports
 * for tests.
 *
 * Identified by email, not password: `pnpm db:seed` owns the Postgres row and
 * its password, while the credential that would have to match lives in Clerk.
 * Email is the only field both sides agree on, and it is what the app uses to
 * claim the seeded account.
 */
export async function signIn(page: Page): Promise<void> {
  // clerk.signIn needs the SDK loaded on an unprotected page first. The
  // marketing root mounts ClerkProvider and never redirects.
  await page.goto("/");
  await clerk.loaded({ page });

  await clerk.signIn({ page, emailAddress: DEMO_EMAIL });

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(signOutButton(page)).toBeVisible();
}

/**
 * The sidebar's sign-out button, and the suite's marker for "this page rendered
 * inside the authenticated shell".
 *
 * `exact` is load-bearing: /settings/security also offers "Sign out everywhere
 * else", and a substring match resolves to both buttons.
 */
export function signOutButton(page: Page): Locator {
  return page.getByRole("button", { name: "Sign out", exact: true });
}
