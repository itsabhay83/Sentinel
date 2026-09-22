import type { FailureCode } from "./failure-codes";
import type { MonitorStatus } from "./monitor";

/**
 * Multi-region quorum consensus — the core differentiator.
 *
 * A single probe cannot distinguish "the site is down" from "the route between
 * one datacenter and the site is broken". These pure functions turn a set of
 * per-region results into one defensible verdict, then damp it with
 * confirmation counts so transient blips never page anyone.
 *
 * Everything here is deliberately side-effect free and dependency free: the
 * scheduler owns the I/O, this module owns the decision.
 */

export interface RegionResult {
  readonly regionCode: string;
  readonly ok: boolean;
  readonly failureCode: FailureCode | null;
  readonly totalMs: number;
}

export interface ConsensusConfig {
  /** Fraction of reporting regions that must fail before declaring DOWN. */
  readonly quorumRatio: number;
  /** Below this many reporting regions the cycle is INCONCLUSIVE. */
  readonly minRegionsRequired: number;
}

export type ConsensusVerdict = "UP" | "DOWN" | "PARTIAL_OUTAGE" | "INCONCLUSIVE";

export interface ConsensusOutcome {
  readonly verdict: ConsensusVerdict;
  /** Regions that reported a failure this cycle. */
  readonly failingRegions: readonly string[];
  /** Regions that reported at all (quarantined ones already excluded). */
  readonly reportingRegions: readonly string[];
  /** Number of failures required to reach quorum, for UI explanation. */
  readonly quorumThreshold: number;
  readonly failureCount: number;
  /** Most common failure code among failing regions — drives the incident badge. */
  readonly primaryFailureCode: FailureCode | null;
}

export const DEFAULT_CONSENSUS: ConsensusConfig = {
  quorumRatio: 0.6,
  minRegionsRequired: 2,
};

/**
 * Section 3.2, implemented exactly:
 *
 *   N  < min_regions_required     → INCONCLUSIVE   (never alerts)
 *   F == 0                        → UP
 *   F >= ceil(N * quorum_ratio)   → DOWN
 *   1 <= F <  quorum              → PARTIAL_OUTAGE
 */
export function evaluateConsensus(
  results: readonly RegionResult[],
  config: ConsensusConfig = DEFAULT_CONSENSUS,
): ConsensusOutcome {
  const reportingRegions = results.map((r) => r.regionCode);
  const failures = results.filter((r) => !r.ok);
  const failingRegions = failures.map((r) => r.regionCode);

  const n = results.length;
  const f = failures.length;
  const quorumThreshold = Math.max(1, Math.ceil(n * config.quorumRatio));

  const primaryFailureCode = dominantFailureCode(failures);

  if (n < config.minRegionsRequired) {
    return {
      verdict: "INCONCLUSIVE",
      failingRegions,
      reportingRegions,
      quorumThreshold,
      failureCount: f,
      primaryFailureCode,
    };
  }

  if (f === 0) {
    return {
      verdict: "UP",
      failingRegions: [],
      reportingRegions,
      quorumThreshold,
      failureCount: 0,
      primaryFailureCode: null,
    };
  }

  const verdict: ConsensusVerdict = f >= quorumThreshold ? "DOWN" : "PARTIAL_OUTAGE";

  return {
    verdict,
    failingRegions,
    reportingRegions,
    quorumThreshold,
    failureCount: f,
    primaryFailureCode,
  };
}

/** Most frequent failure code; ties break toward the first seen for determinism. */
function dominantFailureCode(failures: readonly RegionResult[]): FailureCode | null {
  if (failures.length === 0) return null;
  const counts = new Map<FailureCode, number>();
  for (const failure of failures) {
    const code = failure.failureCode ?? "UNKNOWN";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best: FailureCode | null = null;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Confirmation damping
// ---------------------------------------------------------------------------

export interface ConfirmationConfig {
  /** Consecutive bad cycles required before a monitor is declared DOWN. */
  readonly confirmationFailures: number;
  /** Consecutive good cycles required before a monitor recovers to UP. */
  readonly confirmationSuccesses: number;
}

export const DEFAULT_CONFIRMATION: ConfirmationConfig = {
  confirmationFailures: 2,
  confirmationSuccesses: 2,
};

export interface MonitorRuntimeState {
  readonly status: MonitorStatus;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
}

export interface StateTransition {
  readonly status: MonitorStatus;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  /** True when `status` differs from the previous status. */
  readonly changed: boolean;
}

/**
 * Applies confirmation counting to a raw consensus verdict.
 *
 * A monitor only becomes DOWN/PARTIAL_OUTAGE after `confirmationFailures`
 * consecutive bad cycles, and only recovers after `confirmationSuccesses`
 * consecutive good ones. This kills essentially all false positives from
 * single-cycle blips, at the cost of one extra interval of detection latency.
 *
 * INCONCLUSIVE never advances either counter — a cycle nobody reported on is
 * not evidence of anything.
 */
export function applyConfirmation(
  previous: MonitorRuntimeState,
  outcome: ConsensusOutcome,
  config: ConfirmationConfig = DEFAULT_CONFIRMATION,
): StateTransition {
  if (outcome.verdict === "INCONCLUSIVE") {
    return {
      status: previous.status === "PENDING" ? "PENDING" : previous.status,
      consecutiveFailures: previous.consecutiveFailures,
      consecutiveSuccesses: previous.consecutiveSuccesses,
      changed: false,
    };
  }

  if (outcome.verdict === "UP") {
    const successes = previous.consecutiveSuccesses + 1;
    const isCurrentlyBad =
      previous.status === "DOWN" ||
      previous.status === "PARTIAL_OUTAGE" ||
      previous.status === "DEGRADED";

    // Already healthy (or never observed): first clean cycle promotes to UP.
    if (!isCurrentlyBad) {
      return {
        status: "UP",
        consecutiveFailures: 0,
        consecutiveSuccesses: successes,
        changed: previous.status !== "UP",
      };
    }

    // Recovering from a bad state requires confirmation.
    if (successes >= config.confirmationSuccesses) {
      return {
        status: "UP",
        consecutiveFailures: 0,
        consecutiveSuccesses: successes,
        changed: true,
      };
    }

    return {
      status: previous.status,
      consecutiveFailures: 0,
      consecutiveSuccesses: successes,
      changed: false,
    };
  }

  // verdict is DOWN or PARTIAL_OUTAGE
  const failures = previous.consecutiveFailures + 1;
  const target: MonitorStatus = outcome.verdict === "DOWN" ? "DOWN" : "PARTIAL_OUTAGE";

  if (failures >= config.confirmationFailures) {
    return {
      status: target,
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      changed: previous.status !== target,
    };
  }

  // Not yet confirmed — hold the previous status but remember the failure.
  return {
    status: previous.status === "PENDING" ? "PENDING" : previous.status,
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    changed: false,
  };
}

// ---------------------------------------------------------------------------
// Region quarantine — "our probe's ISP is broken, not the customer's site"
// ---------------------------------------------------------------------------

export interface RegionWindowStats {
  readonly regionCode: string;
  readonly totalChecks: number;
  readonly failedChecks: number;
}

export interface QuarantineConfig {
  /** Region failure rate above which the region is suspect. */
  readonly regionFailureRateThreshold: number;
  /** Global failure rate below which a lone bad region means the region is at fault. */
  readonly globalFailureRateCeiling: number;
  /** Ignore regions with too little traffic to judge. */
  readonly minChecksInWindow: number;
}

export const DEFAULT_QUARANTINE: QuarantineConfig = {
  regionFailureRateThreshold: 0.4,
  globalFailureRateCeiling: 0.1,
  minChecksInWindow: 5,
};

export interface QuarantineDecision {
  readonly regionCode: string;
  readonly regionFailureRate: number;
  /** Failure rate across every region except this one. */
  readonly peerFailureRate: number;
  readonly reason: string;
}

/**
 * If a single region fails >40% of its checks in a 5-minute window while the
 * rest of the fleet stays under 10%, the region — not the internet — is
 * broken. Quarantined regions are excluded from quorum until they recover.
 *
 * The health ceiling is measured across *peer* regions, deliberately excluding
 * the region under judgement. Measuring it fleet-wide would make the rule
 * self-defeating: with eight equal-weight regions, one region failing 100% of
 * its checks single-handedly pushes the fleet-wide rate to 12.5% and the guard
 * could never fire — exactly the case it exists to catch.
 */
export function detectQuarantinedRegions(
  windows: readonly RegionWindowStats[],
  config: QuarantineConfig = DEFAULT_QUARANTINE,
): QuarantineDecision[] {
  const totalChecks = windows.reduce((sum, w) => sum + w.totalChecks, 0);
  const totalFailed = windows.reduce((sum, w) => sum + w.failedChecks, 0);
  if (totalChecks === 0) return [];

  const decisions: QuarantineDecision[] = [];
  for (const window of windows) {
    if (window.totalChecks < config.minChecksInWindow) continue;

    const regionFailureRate = window.failedChecks / window.totalChecks;
    if (regionFailureRate <= config.regionFailureRateThreshold) continue;

    const peerChecks = totalChecks - window.totalChecks;
    const peerFailed = totalFailed - window.failedChecks;
    // A lone region with no peers cannot be cross-checked, so it is never
    // quarantined — we would be silencing our only source of truth.
    if (peerChecks === 0) continue;

    const peerFailureRate = peerFailed / peerChecks;
    if (peerFailureRate >= config.globalFailureRateCeiling) continue;

    decisions.push({
      regionCode: window.regionCode,
      regionFailureRate,
      peerFailureRate,
      reason:
        `Region failed ${(regionFailureRate * 100).toFixed(0)}% of its checks while every ` +
        `other region failed just ${(peerFailureRate * 100).toFixed(1)}%. ` +
        `Excluded from quorum — this is a probe-side network fault, not a customer outage.`,
    });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Statistical degradation detection
// ---------------------------------------------------------------------------

export interface DegradationConfig {
  /** Multiple of the rolling baseline that counts as degraded. */
  readonly multiplier: number;
  /** Consecutive 5-minute buckets that must breach before alerting. */
  readonly consecutiveBuckets: number;
  /** Never fire below this absolute latency — kills noise on very fast endpoints. */
  readonly floorMs: number;
}

export const DEFAULT_DEGRADATION: DegradationConfig = {
  multiplier: 2.5,
  consecutiveBuckets: 3,
  floorMs: 150,
};

/**
 * The latency a monitor is allowed before it counts as degraded: an explicit
 * per-monitor override, else a multiple of its own rolling baseline, floored so
 * a 20ms endpoint doesn't alert at 50ms. `null` means "nothing to compare
 * against yet" — a brand-new monitor with no baseline is never born degraded.
 *
 * Extracted because two callers need the same rule from different shapes of
 * evidence: `detectDegradation` judges a time series of buckets, while the
 * scheduler judges the regions of a single cycle. Only the evidence differs;
 * the threshold must not.
 */
export function degradationThreshold(
  baselineP95Ms: number | null,
  explicitThresholdMs: number | null,
  config: DegradationConfig = DEFAULT_DEGRADATION,
): number | null {
  if (explicitThresholdMs !== null) return explicitThresholdMs;
  if (baselineP95Ms === null) return null;
  return Math.max(baselineP95Ms * config.multiplier, config.floorMs);
}

/**
 * "Up but 6x slower" is the outage nobody catches until customers complain.
 * Compares recent 5-minute p95 buckets against a rolling 7-day p95 baseline.
 *
 * `recentBucketP95` must be ordered oldest → newest.
 */
export function detectDegradation(
  baselineP95Ms: number | null,
  recentBucketP95: readonly number[],
  explicitThresholdMs: number | null,
  config: DegradationConfig = DEFAULT_DEGRADATION,
): { degraded: boolean; thresholdMs: number | null; breachingBuckets: number } {
  const threshold = degradationThreshold(baselineP95Ms, explicitThresholdMs, config);

  if (threshold === null) return { degraded: false, thresholdMs: null, breachingBuckets: 0 };

  const window = recentBucketP95.slice(-config.consecutiveBuckets);
  const breaching = window.filter((p95) => p95 > threshold).length;

  return {
    degraded: window.length >= config.consecutiveBuckets && breaching === config.consecutiveBuckets,
    thresholdMs: threshold,
    breachingBuckets: breaching,
  };
}

// ---------------------------------------------------------------------------
// SLO / error budget
// ---------------------------------------------------------------------------

export interface ErrorBudget {
  readonly targetPercent: number;
  readonly windowDays: number;
  readonly actualPercent: number;
  /** Minutes of downtime the target permits across the window. */
  readonly allowedDowntimeMinutes: number;
  readonly consumedDowntimeMinutes: number;
  /** 100 = untouched budget, 0 = fully spent, negative = over budget. */
  readonly remainingPercent: number;
  readonly breached: boolean;
}

export function computeErrorBudget(
  targetPercent: number,
  windowDays: number,
  totalChecks: number,
  failedChecks: number,
  intervalSeconds: number,
): ErrorBudget {
  const actualPercent = totalChecks === 0 ? 100 : ((totalChecks - failedChecks) / totalChecks) * 100;
  const windowMinutes = windowDays * 24 * 60;
  const allowedDowntimeMinutes = windowMinutes * (1 - targetPercent / 100);
  const consumedDowntimeMinutes = (failedChecks * intervalSeconds) / 60;
  const remainingPercent =
    allowedDowntimeMinutes === 0
      ? 0
      : ((allowedDowntimeMinutes - consumedDowntimeMinutes) / allowedDowntimeMinutes) * 100;

  return {
    targetPercent,
    windowDays,
    actualPercent,
    allowedDowntimeMinutes,
    consumedDowntimeMinutes,
    remainingPercent: Math.max(-100, Math.min(100, remainingPercent)),
    breached: actualPercent < targetPercent,
  };
}
