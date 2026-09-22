import { expect, test } from "@playwright/test";

/**
 * The REST API is key-authenticated and tenant-scoped. These two cases are the
 * cheapest proof that `apps/web/src/lib/api-auth.ts` is still wired in front of
 * the route — a regression that removed it would return the seeded org's 21
 * monitors to an anonymous caller.
 */
test.describe("REST API authentication", () => {
  test("GET /api/v1/monitors without an Authorization header is rejected", async ({ request }) => {
    const response = await request.get("/api/v1/monitors");

    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  test("GET /api/v1/monitors with an unknown bearer key is rejected", async ({ request }) => {
    const response = await request.get("/api/v1/monitors", {
      headers: { Authorization: "Bearer sk_live_bogus" },
    });

    expect(response.status()).toBe(401);

    // The success shape of this route is `{ data: [...] }`. A rejected request
    // must carry the error contract and no `data` key at all — that is what
    // proves the handler bailed before it ever queried the org's monitors.
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: "unauthorized" });
    expect(body).not.toHaveProperty("data");
  });
});
