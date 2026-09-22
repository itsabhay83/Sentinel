/**
 * Per-plan caps. This is the billing seam: nothing here integrates Stripe, but
 * every limit a paid tier would unlock already reads from this table.
 */

export const PLANS = ["free", "pro", "business"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  readonly maxMonitors: number;
  readonly minIntervalSeconds: number;
  readonly maxRegionsPerMonitor: number;
  /** Days of raw `checks` rows kept before the partition is dropped. */
  readonly rawRetentionDays: number;
  readonly maxStatusPages: number;
  readonly maxAlertChannels: number;
  readonly maxTeamMembers: number;
  /** Monitor creations allowed per hour, enforced in Redis. */
  readonly monitorCreationsPerHour: number;
}

export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: {
    maxMonitors: 10,
    minIntervalSeconds: 300,
    maxRegionsPerMonitor: 3,
    rawRetentionDays: 7,
    maxStatusPages: 1,
    maxAlertChannels: 2,
    maxTeamMembers: 3,
    monitorCreationsPerHour: 20,
  },
  pro: {
    maxMonitors: 100,
    minIntervalSeconds: 60,
    maxRegionsPerMonitor: 8,
    rawRetentionDays: 30,
    maxStatusPages: 5,
    maxAlertChannels: 20,
    maxTeamMembers: 15,
    monitorCreationsPerHour: 100,
  },
  business: {
    maxMonitors: 500,
    minIntervalSeconds: 30,
    maxRegionsPerMonitor: 8,
    rawRetentionDays: 30,
    maxStatusPages: 25,
    maxAlertChannels: 100,
    maxTeamMembers: 100,
    monitorCreationsPerHour: 500,
  },
};

export function limitsFor(plan: string): PlanLimits {
  return PLAN_LIMITS[(PLANS as readonly string[]).includes(plan) ? (plan as Plan) : "free"];
}

/** Rollup retention is uniform across plans — rollups are cheap. */
export const ROLLUP_RETENTION_MONTHS = 13;
