import { describe, expect, it } from "vitest";
import type { FailureCode, RegionResult } from "@sentinel/shared";
import { statusFor } from "./evaluate";

/**
 * `statusFor` is the seam where a latency judgement is layered onto a healthy
 * consensus verdict. Everything else in the evaluator talks to Postgres; this
 * function is pure, and it is the piece most likely to be "simplified" into
 * treating slowness as a failure — which would push slow monitors through the
 * failure counters and open DOWN incidents for sites that are answering fine.
 */

function ok(regionCode: string, totalMs: number): RegionResult {
  return { regionCode, ok: true, failureCode: null, totalMs };
}

function bad(regionCode: string, failureCode: FailureCode): RegionResult {
  return { regionCode, ok: false, failureCode, totalMs: 0 };
}

describe("statusFor", () => {
  it("passes DOWN through untouched", () => {
    const results = [bad("bom", "HTTP_5XX"), bad("fra", "HTTP_5XX")];
    expect(statusFor("DOWN", results, 500)).toEqual({
      status: "DOWN",
      degraded: false,
    });
  });

  it("passes PARTIAL_OUTAGE through untouched", () => {
    const results = [ok("bom", 90), bad("gru", "TCP_TIMEOUT")];
    expect(statusFor("PARTIAL_OUTAGE", results, 500)).toEqual({
      status: "PARTIAL_OUTAGE",
      degraded: false,
    });
  });

  it("passes INCONCLUSIVE through untouched", () => {
    expect(statusFor("INCONCLUSIVE", [], 500)).toEqual({
      status: "INCONCLUSIVE",
      degraded: false,
    });
  });

  it("never applies a latency judgement to a failing verdict", () => {
    // Slow AND down is still just down — degradation must not mask an outage.
    const results = [bad("bom", "HTTP_5XX"), ok("fra", 9_000)];
    expect(statusFor("DOWN", results, 100).status).toBe("DOWN");
  });

  it("stays UP when every region is inside the explicit threshold", () => {
    const results = [ok("bom", 140), ok("fra", 210), ok("iad", 95)];
    expect(statusFor("UP", results, 800)).toEqual({
      status: "UP",
      degraded: false,
    });
  });

  it("reports DEGRADED when latency breaches the explicit threshold", () => {
    const results = [ok("bom", 1_400), ok("fra", 1_600), ok("iad", 1_500)];
    expect(statusFor("UP", results, 800)).toEqual({
      status: "DEGRADED",
      degraded: true,
    });
  });

  it("stays UP without an explicit threshold and no baseline to compare against", () => {
    // No configured threshold and no stored baseline means there is nothing to
    // breach — a brand-new monitor must not be born DEGRADED.
    const results = [ok("bom", 4_000), ok("fra", 4_200)];
    expect(statusFor("UP", results, null)).toEqual({
      status: "UP",
      degraded: false,
    });
  });

  it("ignores failed regions when measuring latency", () => {
    // A failed region reports totalMs 0. Averaging it in would drag the sample
    // down and hide real degradation on the regions that actually answered.
    const results = [bad("gru", "TCP_TIMEOUT"), ok("bom", 1_200), ok("fra", 1_300)];
    expect(statusFor("UP", results, 600).status).toBe("DEGRADED");
  });

  it("stays UP when no region reported a latency at all", () => {
    expect(statusFor("UP", [], 500)).toEqual({ status: "UP", degraded: false });
  });
});
