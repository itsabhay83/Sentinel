import { describe, expect, it } from "vitest";
import { PLANS, PLAN_LIMITS, ROLLUP_RETENTION_MONTHS, limitsFor, type Plan, type PlanLimits } from "./limits";

const NUMERIC_LIMITS = [
  "maxMonitors",
  "minIntervalSeconds",
  "maxRegionsPerMonitor",
  "rawRetentionDays",
  "maxStatusPages",
  "maxAlertChannels",
  "maxTeamMembers",
  "monitorCreationsPerHour",
] as const satisfies readonly (keyof PlanLimits)[];

describe("PLAN_LIMITS", () => {
  it("declares exactly the plans in PLANS and nothing else", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...PLANS].sort());
  });

  it.each(PLANS)("%s has a positive integer for every limit", (plan) => {
    for (const key of NUMERIC_LIMITS) {
      const value = PLAN_LIMITS[plan][key];
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it.each(PLANS)("%s declares every limit and no undeclared extras", (plan) => {
    expect(Object.keys(PLAN_LIMITS[plan]).sort()).toEqual([...NUMERIC_LIMITS].sort());
  });

  it.each(PLANS)("%s never offers more regions than the region table has", (plan) => {
    expect(PLAN_LIMITS[plan].maxRegionsPerMonitor).toBeLessThanOrEqual(8);
  });

  it("widens allowances as the plan gets more expensive", () => {
    const widening = [
      "maxMonitors",
      "maxStatusPages",
      "maxAlertChannels",
      "maxTeamMembers",
      "monitorCreationsPerHour",
    ] as const satisfies readonly (keyof PlanLimits)[];

    for (const key of widening) {
      expect(PLAN_LIMITS.free[key]).toBeLessThan(PLAN_LIMITS.pro[key]);
      expect(PLAN_LIMITS.pro[key]).toBeLessThan(PLAN_LIMITS.business[key]);
    }
  });

  it("tightens the minimum interval as the plan gets more expensive", () => {
    expect(PLAN_LIMITS.free.minIntervalSeconds).toBeGreaterThan(PLAN_LIMITS.pro.minIntervalSeconds);
    expect(PLAN_LIMITS.pro.minIntervalSeconds).toBeGreaterThan(
      PLAN_LIMITS.business.minIntervalSeconds,
    );
  });

  it("never lets a paid plan keep less raw history than free", () => {
    expect(PLAN_LIMITS.pro.rawRetentionDays).toBeGreaterThanOrEqual(PLAN_LIMITS.free.rawRetentionDays);
    expect(PLAN_LIMITS.business.rawRetentionDays).toBeGreaterThanOrEqual(
      PLAN_LIMITS.pro.rawRetentionDays,
    );
  });

  it("offers an interval that the CHECK_INTERVALS ladder actually contains", () => {
    const allowed = new Set([30, 60, 300, 900, 1800, 3600]);
    for (const plan of PLANS) expect(allowed.has(PLAN_LIMITS[plan].minIntervalSeconds)).toBe(true);
  });
});

describe("limitsFor", () => {
  it.each(PLANS)("returns the %s row by name", (plan) => {
    expect(limitsFor(plan)).toBe(PLAN_LIMITS[plan]);
  });

  it.each(["", "enterprise", "FREE", "Pro", "free ", "__proto__", "constructor"])(
    "falls back to free for the unknown plan %j",
    (unknown) => {
      // An unrecognised plan must never widen limits — including prototype keys,
      // which would otherwise resolve to a function off Object.prototype.
      expect(limitsFor(unknown)).toBe(PLAN_LIMITS.free);
    },
  );

  it("does not widen limits for a plan that only differs in case", () => {
    const upper = limitsFor("BUSINESS");
    expect(upper.maxMonitors).toBe(PLAN_LIMITS.free.maxMonitors);
  });
});

describe("PLANS", () => {
  it("lists each plan once", () => {
    expect(new Set(PLANS).size).toBe(PLANS.length);
  });

  it("starts at free, which is the fallback tier", () => {
    expect(PLANS[0]).toBe("free");
  });

  it("is the same membership limitsFor recognises", () => {
    const recognised = PLANS.filter((plan: Plan) => limitsFor(plan) === PLAN_LIMITS[plan]);
    expect(recognised).toEqual([...PLANS]);
  });
});

describe("ROLLUP_RETENTION_MONTHS", () => {
  it("keeps more than a year so year-on-year charts have a comparison period", () => {
    expect(Number.isInteger(ROLLUP_RETENTION_MONTHS)).toBe(true);
    expect(ROLLUP_RETENTION_MONTHS).toBeGreaterThan(12);
  });

  it("outlives every plan's raw retention, since rollups are what remains", () => {
    const longestRawDays = Math.max(...PLANS.map((plan) => PLAN_LIMITS[plan].rawRetentionDays));
    expect(ROLLUP_RETENTION_MONTHS * 28).toBeGreaterThan(longestRawDays);
  });
});
