import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * The heartbeat limiter is keyed on the ping token, not the caller IP, so a
 * fresh random token per run gets its own budget: this spec can never starve
 * another spec, another worker, or a second run of itself.
 *
 * Policy is 60 requests / 60s with continuous refill, so the first 429 lands
 * just past request 60. The cap is deliberately loose rather than exact — an
 * assertion on the precise request number would fail on a slow machine where
 * the bucket has refilled a token or two mid-loop.
 */
const REQUEST_CAP = 90;
const EXPECTED_CAPACITY = "60";

test.describe.configure({ mode: "serial" });

test.describe("heartbeat rate limiting", () => {
  test("a burst against one token trips a 429 carrying retry-after", async ({ request }) => {
    const token = `e2e-${randomUUID()}`;
    let trippedAt: number | null = null;

    for (let attempt = 1; attempt <= REQUEST_CAP; attempt += 1) {
      const response = await request.get(`/api/heartbeat/${token}`);

      if (response.status() === 429) {
        const headers = response.headers();
        expect(headers["retry-after"], "429 must tell the caller when to retry").toMatch(/^\d+$/);
        expect(headers["ratelimit-limit"]).toBe(EXPECTED_CAPACITY);
        expect(headers["ratelimit-remaining"]).toBe("0");
        trippedAt = attempt;
        break;
      }

      // A random token matches no heartbeat row, so every request the limiter
      // lets through is a 404. Anything else means the route changed shape and
      // the loop is no longer measuring what it claims to.
      expect(response.status(), `unexpected status on request ${attempt}`).toBe(404);
    }

    expect(
      trippedAt,
      `no 429 after ${REQUEST_CAP} requests — the heartbeat limiter is not enforcing its 60/60s policy`,
    ).not.toBeNull();
  });
});
