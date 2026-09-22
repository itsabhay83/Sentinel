import { expect, test } from "@playwright/test";

import { STATUS_PAGE_SLUG, STATUS_PAGE_TITLE } from "../support/fixtures";

test.describe("public status page", () => {
  test("renders the seeded org's status page to an anonymous visitor", async ({ page }) => {
    const response = await page.goto(`/status/${STATUS_PAGE_SLUG}`);
    if (!response) throw new Error("navigating to the status page produced no response");

    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(`${STATUS_PAGE_TITLE} · Sentinel`);
    await expect(page.getByRole("heading", { name: STATUS_PAGE_TITLE, level: 1 })).toBeVisible();

    // Status pages are the one route middleware allows to be framed, because
    // customers embed them in their own dashboards.
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors *");
  });

  test("serves an RSS feed of the org's incidents", async ({ request }) => {
    const response = await request.get(`/status/${STATUS_PAGE_SLUG}/rss`);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/rss+xml");

    const body = await response.text();
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain(`<title>${STATUS_PAGE_TITLE}</title>`);
  });
});
