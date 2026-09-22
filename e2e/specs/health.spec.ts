import { expect, test } from "@playwright/test";

test.describe("health endpoints", () => {
  test("GET /api/live reports the web process alive without touching a dependency", async ({ request }) => {
    const response = await request.get("/api/live");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "web" });
  });

  test("GET /api/ready reports postgres and redis reachable", async ({ request }) => {
    const response = await request.get("/api/ready");

    // 503 here is the app correctly reporting a dependency outage, so a failure
    // means the stack under test is broken, not that the assertion is wrong.
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, database: true, redis: true });
  });
});
