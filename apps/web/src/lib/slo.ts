/**
 * Error budget and burn rate for an availability SLO.
 *
 * The framing here is a *ratio* of failed checks to total checks, not a count
 * of downtime minutes. `check_rollups_1h` holds one row per (monitor, region,
 * hour), so `sum(count)` counts region-checks rather than wall-clock checks:
 * multiplying a failure count by the monitor's interval — the time framing —
 * overstates downtime by roughly the number of probing regions. The ratio is
 * immune to that, because the region multiplier cancels in the numerator and
 * the denominator.
 *
 * Every arithmetic edge is a named state rather than a sentinel number. A
 * window with no checks is not "0% burned", and a 100% target does not have an
 * infinite burn rate — both are answers the UI has to phrase differently.
 */

/** numeric(6,3) holds up to 999.999; the useful range is a fraction of that. */
export const MIN_TARGET_PERCENT = 50;
export const MAX_TARGET_PERCENT = 99.999;
/** The 1h rollups are retained 13 months, so a year-long window still has data. */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 365;

export type ErrorBudget =
  /** No check landed in the window — nothing has been measured, good or bad. */
  | { readonly state: "no_data" }
  /** A 100% target allows zero failures, so there is no budget to divide by. */
  | { readonly state: "no_budget"; readonly failureRatio: number }
  | {
      readonly state: "measured";
      readonly failureRatio: number;
      /** 1 exactly exhausts the budget across the window; >1 exhausts it early. */
      readonly burnRate: number;
      /** Fraction of the budget still unspent, clamped to [0, 1]. */
      readonly remainingRatio: number;
    };

export function computeBudget(
  targetPercent: number,
  totalChecks: number,
  failedChecks: number,
): ErrorBudget {
  if (totalChecks <= 0) return { state: "no_data" };

  const failureRatio = failedChecks / totalChecks;
  const allowedFailureRatio = 1 - targetPercent / 100;
  if (allowedFailureRatio <= 0) return { state: "no_budget", failureRatio };

  const burnRate = failureRatio / allowedFailureRatio;
  return {
    state: "measured",
    failureRatio,
    burnRate,
    remainingRatio: Math.min(1, Math.max(0, 1 - burnRate)),
  };
}

export type BurnSeverity = "ok" | "warn" | "critical";

/**
 * Thresholds follow the multi-window burn-rate convention: a rate of 1 spends
 * the budget exactly as fast as the window replenishes it, and 10 spends it in
 * a tenth of the window — fast enough to page on.
 */
export function burnSeverity(burnRate: number): BurnSeverity {
  if (burnRate >= 10) return "critical";
  if (burnRate >= 1) return "warn";
  return "ok";
}

/** Days until the remaining budget is spent at the current rate, or null when it never is. */
export function daysUntilExhausted(budget: ErrorBudget, windowDays: number): number | null {
  if (budget.state !== "measured") return null;
  if (budget.burnRate <= 0 || budget.remainingRatio <= 0) return null;
  return (windowDays * budget.remainingRatio) / budget.burnRate;
}

export function availabilityPercent(budget: ErrorBudget): number | null {
  if (budget.state === "no_data") return null;
  return (1 - budget.failureRatio) * 100;
}
