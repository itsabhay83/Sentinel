import { expect, test } from "@playwright/test";

import { CSRF_COOKIE, CSRF_TOKEN_PATTERN } from "../support/fixtures";

function required(headers: Record<string, string>, name: string): string {
  const value = headers[name];
  expect(value, `response is missing the ${name} header`).toBeDefined();
  return value ?? "";
}

test.describe("middleware security headers", () => {
  test("/login carries the full header set and mints a CSRF cookie", async ({ page }) => {
    const response = await page.goto("/login");
    if (!response) throw new Error("navigating to /login produced no response");

    const headers = response.headers();

    const csp = required(headers, "content-security-policy");
    // `frame-ancestors` is what actually blocks embedding; `object-src 'none'`
    // kills the legacy plugin vector. Both are the directives most often lost
    // when someone edits the policy string, so they are asserted by name.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");

    expect(required(headers, "x-frame-options")).toBe("DENY");
    expect(required(headers, "x-content-type-options")).toBe("nosniff");
    expect(required(headers, "referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(required(headers, "permissions-policy")).toContain("geolocation=()");
    expect(required(headers, "strict-transport-security")).toMatch(/^max-age=\d+/);
  });

  test("/login sets the sentinel_csrf double-submit cookie", async ({ page }) => {
    await page.goto("/login");

    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === CSRF_COOKIE);

    expect(csrf, `middleware did not set the ${CSRF_COOKIE} cookie`).toBeDefined();
    expect(csrf?.value).toMatch(CSRF_TOKEN_PATTERN);
    // Readable by the page on purpose: the double-submit pattern needs the form
    // to echo the same value back in a hidden field.
    expect(csrf?.httpOnly).toBe(false);
    expect(csrf?.path).toBe("/");
  });
});
