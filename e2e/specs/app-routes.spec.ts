import { expect, test } from "@playwright/test";

import { signOutButton } from "../support/auth";
import { STORAGE_STATE } from "../support/fixtures";

/**
 * Every authenticated page the sidebar links to. Each entry pins the page's
 * `metadata.title`, so a route that silently falls back to the root layout's
 * "Sentinel" default — or renders someone else's page — fails here.
 */
const ROUTES = [
  { path: "/dashboard", title: "Monitors · Sentinel" },
  { path: "/incidents", title: "Incidents · Sentinel" },
  { path: "/regions", title: "Regions · Sentinel" },
  { path: "/slos", title: "SLOs · Sentinel" },
  { path: "/settings/alerts", title: "Alerting · Sentinel" },
  { path: "/settings/api", title: "API keys · Sentinel" },
  { path: "/settings/audit", title: "Audit log · Sentinel" },
  { path: "/settings/data", title: "Data & privacy · Sentinel" },
  { path: "/settings/security", title: "Security · Sentinel" },
  { path: "/settings/status-pages", title: "Status pages · Sentinel" },
  { path: "/settings/team", title: "Team · Sentinel" },
] as const;

test.use({ storageState: STORAGE_STATE });

test.describe("authenticated route smoke", () => {
  for (const { path, title } of ROUTES) {
    test(`${path} renders for a signed-in owner`, async ({ page }) => {
      const response = await page.goto(path);
      if (!response) throw new Error(`navigating to ${path} produced no response`);

      expect(response.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page).toHaveTitle(title);

      // The shell only renders once `requireOrg()` has resolved a session, so a
      // visible "Sign out" means the page rendered inside the authenticated
      // layout rather than as an error boundary or a login bounce.
      await expect(signOutButton(page)).toBeVisible();

      // Next's production error boundaries render one of these strings instead
      // of the page. A 200 alone does not rule that out.
      await expect(page.locator("body")).not.toContainText("Application error");
      await expect(page.locator("body")).not.toContainText("This page could not be found");
    });
  }
});
