import { test as setup } from "@playwright/test";

import { signIn } from "./auth";
import { STORAGE_STATE } from "./fixtures";

/**
 * Signs in once and parks the session on disk. The route-smoke spec then opens
 * eleven pages from that state instead of replaying the login form eleven
 * times, which would also burn the login rate-limit budget.
 */
setup("authenticate as the seeded demo owner", async ({ page }) => {
  await signIn(page);
  await page.context().storageState({ path: STORAGE_STATE });
});
