import { sql as rawSql } from "@sentinel/db";
import {
  applyConfirmation,
  degradationThreshold,
  evaluateConsensus,
  type MonitorStatus,
  type RegionResult,
} from "@sentinel/shared";

import { pendingCycles, type CycleRow } from "./cycles";
import { applyIncidentTransition } from "./incident-writes";
import { logger } from "./logger";

/**
 * How long to wait for stragglers before judging a cycle on partial data. A
 * region that never reports must not stall the verdict forever -- but judging
 * too early would read a slow region as a missing one.
 */
const CYCLE_GRACE_MS = 20_000;

/**
 * Layers a latency judgement onto a healthy consensus verdict.
 *
 * The evidence here is one cycle's regions, not a time series, so this compares
 * the *median* healthy region against the threshold rather than demanding N
 * consecutive breaches. Using the time-series `detectDegradation` on this shape
 * would make the answer depend on region array order and would leave any
 * monitor with fewer than three regions permanently unable to report DEGRADED.
 * The median (not the mean) is what makes one slow region insufficient — a
 * single laggard is a regional problem, and PARTIAL_OUTAGE already covers that.
 */
export function statusFor(
  verdict: string,
  results: RegionResult[],
  degradedThresholdMs: number | null,
  baselineP95Ms: number | null = null,
): { status: MonitorStatus; degraded: boolean } {
  if (verdict !== "UP") {
    return { status: verdict as MonitorStatus, degraded: false };
  }

  const threshold = degradationThreshold(baselineP95Ms, degradedThresholdMs);
  if (threshold === null) return { status: "UP", degraded: false };

  // Failed regions report totalMs 0; including them would drag the sample down
  // and hide real degradation on the regions that actually answered.
  const latencies = results
    .filter((result) => result.ok)
    .map((result) => result.totalMs)
    .sort((a, b) => a - b);
  if (latencies.length === 0) return { status: "UP", degraded: false };

  const median = latencies[Math.floor((latencies.length - 1) / 2)] ?? 0;
  return median > threshold
    ? { status: "DEGRADED", degraded: true }
    : { status: "UP", degraded: false };
}

function medianOk(results: RegionResult[]): number | null {
  const okLatencies = results.filter((r) => r.ok).map((r) => r.totalMs);
  if (okLatencies.length === 0) return null;
  return Math.round(
    [...okLatencies].sort((a, b) => a - b)[Math.floor(okLatencies.length / 2)] ?? 0,
  );
}

async function evaluateRow(row: CycleRow, now: Date): Promise<boolean> {
  const results = row.results ?? [];
  const complete = results.length >= row.expected_regions;
  const expired = now.getTime() - new Date(row.oldest_check).getTime() > CYCLE_GRACE_MS;
  if (!complete && !expired) return false;

  const consensus = evaluateConsensus(results, {
    quorumRatio: Number.parseFloat(row.quorum_ratio),
    minRegionsRequired: row.min_regions_required,
  });

  const { status: proposed } = statusFor(consensus.verdict, results, row.degraded_threshold_ms);

  const transition = applyConfirmation(
    {
      status: row.status,
      consecutiveFailures: row.consecutive_failures,
      consecutiveSuccesses: row.consecutive_successes,
    },
    { ...consensus, verdict: proposed === "DEGRADED" ? "UP" : consensus.verdict },
    {
      confirmationFailures: row.confirmation_failures,
      confirmationSuccesses: row.confirmation_successes,
    },
  );

  // Degradation is a latency judgement on a healthy monitor, so it rides on top
  // of the confirmed UP state rather than going through the failure counters.
  const finalStatus: MonitorStatus =
    transition.status === "UP" && proposed === "DEGRADED" ? "DEGRADED" : transition.status;

  const changed = finalStatus !== row.status;

  await rawSql.begin(async (tx) => {
    const [locked] = await tx<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${row.monitor_id})) AS ok
    `;
    if (locked?.ok !== true) return;

    await tx`
      UPDATE monitor_state SET
        status = ${finalStatus},
        since = CASE WHEN ${changed} THEN ${now.toISOString()}::timestamptz ELSE monitor_state.since END,
        last_check_at = ${now.toISOString()}::timestamptz,
        consecutive_failures = ${transition.consecutiveFailures},
        consecutive_successes = ${transition.consecutiveSuccesses},
        failing_regions = ${consensus.failingRegions},
        last_latency_ms = ${medianOk(results)},
        current_cycle_id = NULL
      WHERE monitor_id = ${row.monitor_id}
    `;

    if (!changed) return;
    await applyIncidentTransition(tx, { row, status: finalStatus, consensus, at: now });
  });

  return changed;
}

export async function evaluatePendingCycles(now = new Date()): Promise<number> {
  const rows = await pendingCycles();
  let transitions = 0;
  for (const row of rows) {
    try {
      if (await evaluateRow(row, now)) transitions += 1;
    } catch (error) {
      logger.error(
        { cycleId: row.cycle_id, monitorId: row.monitor_id, err: error },
        "consensus evaluation failed",
      );
    }
  }
  return transitions;
}
