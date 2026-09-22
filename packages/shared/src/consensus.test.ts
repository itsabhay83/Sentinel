import { describe, expect, it } from "vitest";
import {
  applyConfirmation,
  computeErrorBudget,
  DEFAULT_CONFIRMATION,
  DEFAULT_CONSENSUS,
  detectDegradation,
  detectQuarantinedRegions,
  evaluateConsensus,
  type ConsensusVerdict,
  type MonitorRuntimeState,
  type RegionResult,
} from "./consensus";
import type { FailureCode } from "./failure-codes";
import type { MonitorStatus } from "./monitor";

function ok(regionCode: string, totalMs = 120): RegionResult {
  return { regionCode, ok: true, failureCode: null, totalMs };
}

function bad(regionCode: string, failureCode: FailureCode = "HTTP_5XX", totalMs = 0): RegionResult {
  return { regionCode, ok: false, failureCode, totalMs };
}

// ---------------------------------------------------------------------------
// Section 3.2 — the quorum table. Every row is a documented transition.
// ---------------------------------------------------------------------------

interface ConsensusCase {
  readonly name: string;
  readonly results: readonly RegionResult[];
  readonly quorumRatio: number;
  readonly minRegions: number;
  readonly expected: ConsensusVerdict;
  readonly expectedThreshold: number;
  readonly expectedFailing: readonly string[];
}

const CONSENSUS_TABLE: readonly ConsensusCase[] = [
  {
    name: "no regions reported at all → INCONCLUSIVE",
    results: [],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "INCONCLUSIVE",
    expectedThreshold: 1,
    expectedFailing: [],
  },
  {
    name: "one region reporting under a min of 2 → INCONCLUSIVE even though it failed",
    results: [bad("bom")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "INCONCLUSIVE",
    expectedThreshold: 1,
    expectedFailing: ["bom"],
  },
  {
    name: "one region reporting under a min of 2 → INCONCLUSIVE even though it succeeded",
    results: [ok("bom")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "INCONCLUSIVE",
    expectedThreshold: 1,
    expectedFailing: [],
  },
  {
    name: "single region allowed when min_regions is 1 and it is healthy → UP",
    results: [ok("bom")],
    quorumRatio: 0.6,
    minRegions: 1,
    expected: "UP",
    expectedThreshold: 1,
    expectedFailing: [],
  },
  {
    name: "single region allowed when min_regions is 1 and it failed → DOWN",
    results: [bad("bom")],
    quorumRatio: 0.6,
    minRegions: 1,
    expected: "DOWN",
    expectedThreshold: 1,
    expectedFailing: ["bom"],
  },
  {
    name: "F == 0 across three regions → UP",
    results: [ok("bom"), ok("fra"), ok("iad")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "UP",
    expectedThreshold: 2,
    expectedFailing: [],
  },
  {
    name: "1 of 3 failing (threshold 2) → PARTIAL_OUTAGE naming the region",
    results: [bad("bom", "TCP_TIMEOUT"), ok("fra"), ok("iad")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "PARTIAL_OUTAGE",
    expectedThreshold: 2,
    expectedFailing: ["bom"],
  },
  {
    name: "2 of 3 failing meets ceil(3 * 0.6) = 2 → DOWN",
    results: [bad("bom"), bad("fra"), ok("iad")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "DOWN",
    expectedThreshold: 2,
    expectedFailing: ["bom", "fra"],
  },
  {
    name: "3 of 3 failing → DOWN",
    results: [bad("bom"), bad("fra"), bad("iad")],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "DOWN",
    expectedThreshold: 2,
    expectedFailing: ["bom", "fra", "iad"],
  },
  {
    name: "2 of 8 failing (threshold 5) → PARTIAL_OUTAGE",
    results: [
      bad("bom"),
      bad("sin"),
      ok("fra"),
      ok("lhr"),
      ok("iad"),
      ok("sjc"),
      ok("gru"),
      ok("syd"),
    ],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "PARTIAL_OUTAGE",
    expectedThreshold: 5,
    expectedFailing: ["bom", "sin"],
  },
  {
    name: "4 of 8 failing is still below ceil(8 * 0.6) = 5 → PARTIAL_OUTAGE",
    results: [
      bad("bom"),
      bad("sin"),
      bad("fra"),
      bad("lhr"),
      ok("iad"),
      ok("sjc"),
      ok("gru"),
      ok("syd"),
    ],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "PARTIAL_OUTAGE",
    expectedThreshold: 5,
    expectedFailing: ["bom", "sin", "fra", "lhr"],
  },
  {
    name: "5 of 8 failing hits quorum exactly → DOWN",
    results: [
      bad("bom"),
      bad("sin"),
      bad("fra"),
      bad("lhr"),
      bad("iad"),
      ok("sjc"),
      ok("gru"),
      ok("syd"),
    ],
    quorumRatio: 0.6,
    minRegions: 2,
    expected: "DOWN",
    expectedThreshold: 5,
    expectedFailing: ["bom", "sin", "fra", "lhr", "iad"],
  },
  {
    name: "strict quorum of 1.0 requires unanimity — 2 of 3 stays PARTIAL_OUTAGE",
    results: [bad("bom"), bad("fra"), ok("iad")],
    quorumRatio: 1,
    minRegions: 2,
    expected: "PARTIAL_OUTAGE",
    expectedThreshold: 3,
    expectedFailing: ["bom", "fra"],
  },
  {
    name: "lenient quorum of 0.33 lets a single failing region of 3 declare DOWN",
    results: [bad("bom"), ok("fra"), ok("iad")],
    quorumRatio: 0.33,
    minRegions: 2,
    expected: "DOWN",
    expectedThreshold: 1,
    expectedFailing: ["bom"],
  },
  {
    name: "quorum of 0.34 rounds up to 2 of 3, so one failure is only PARTIAL_OUTAGE",
    results: [bad("bom"), ok("fra"), ok("iad")],
    quorumRatio: 0.34,
    minRegions: 2,
    expected: "PARTIAL_OUTAGE",
    expectedThreshold: 2,
    expectedFailing: ["bom"],
  },
  {
    name: "quorum ratio 0 still needs at least one failure (threshold floors at 1)",
    results: [ok("bom"), ok("fra")],
    quorumRatio: 0,
    minRegions: 2,
    expected: "UP",
    expectedThreshold: 1,
    expectedFailing: [],
  },
];

describe("evaluateConsensus (Section 3.2 table)", () => {
  for (const testCase of CONSENSUS_TABLE) {
    it(testCase.name, () => {
      const outcome = evaluateConsensus(testCase.results, {
        quorumRatio: testCase.quorumRatio,
        minRegionsRequired: testCase.minRegions,
      });
      expect(outcome.verdict).toBe(testCase.expected);
      expect(outcome.quorumThreshold).toBe(testCase.expectedThreshold);
      expect(outcome.failingRegions).toEqual(testCase.expectedFailing);
      expect(outcome.reportingRegions).toEqual(testCase.results.map((r) => r.regionCode));
      expect(outcome.failureCount).toBe(testCase.expectedFailing.length);
    });
  }

  it("defaults to a 0.6 ratio and 2 minimum regions", () => {
    expect(DEFAULT_CONSENSUS).toEqual({ quorumRatio: 0.6, minRegionsRequired: 2 });
  });

  it("reports the modal failure code as the primary cause", () => {
    const outcome = evaluateConsensus([
      bad("bom", "TLS_EXPIRED"),
      bad("fra", "HTTP_5XX"),
      bad("iad", "HTTP_5XX"),
    ]);
    expect(outcome.verdict).toBe("DOWN");
    expect(outcome.primaryFailureCode).toBe("HTTP_5XX");
  });

  it("treats a missing failure code as UNKNOWN rather than dropping the failure", () => {
    const outcome = evaluateConsensus([
      { regionCode: "bom", ok: false, failureCode: null, totalMs: 0 },
      ok("fra"),
      ok("iad"),
    ]);
    expect(outcome.primaryFailureCode).toBe("UNKNOWN");
    expect(outcome.verdict).toBe("PARTIAL_OUTAGE");
  });

  it("never reports a primary failure code on a clean cycle", () => {
    expect(evaluateConsensus([ok("bom"), ok("fra")]).primaryFailureCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confirmation damping
// ---------------------------------------------------------------------------

function state(
  status: MonitorStatus,
  consecutiveFailures = 0,
  consecutiveSuccesses = 0,
): MonitorRuntimeState {
  return { status, consecutiveFailures, consecutiveSuccesses };
}

const DOWN_CYCLE = evaluateConsensus([bad("bom"), bad("fra"), bad("iad")]);
const PARTIAL_CYCLE = evaluateConsensus([bad("bom"), ok("fra"), ok("iad")]);
const UP_CYCLE = evaluateConsensus([ok("bom"), ok("fra"), ok("iad")]);
const INCONCLUSIVE_CYCLE = evaluateConsensus([ok("bom")]);

describe("applyConfirmation", () => {
  it("holds UP on the first bad cycle — this is the false-positive killer", () => {
    const next = applyConfirmation(state("UP", 0, 5), DOWN_CYCLE);
    expect(next.status).toBe("UP");
    expect(next.changed).toBe(false);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.consecutiveSuccesses).toBe(0);
  });

  it("declares DOWN on the second consecutive bad cycle", () => {
    const next = applyConfirmation(state("UP", 1, 0), DOWN_CYCLE);
    expect(next.status).toBe("DOWN");
    expect(next.changed).toBe(true);
    expect(next.consecutiveFailures).toBe(2);
  });

  it("does not re-flag `changed` while already DOWN", () => {
    const next = applyConfirmation(state("DOWN", 2, 0), DOWN_CYCLE);
    expect(next.status).toBe("DOWN");
    expect(next.changed).toBe(false);
    expect(next.consecutiveFailures).toBe(3);
  });

  it("escalates PARTIAL_OUTAGE to DOWN once quorum is reached", () => {
    const next = applyConfirmation(state("PARTIAL_OUTAGE", 4, 0), DOWN_CYCLE);
    expect(next.status).toBe("DOWN");
    expect(next.changed).toBe(true);
  });

  it("confirms PARTIAL_OUTAGE with the same two-cycle rule", () => {
    const first = applyConfirmation(state("UP", 0, 3), PARTIAL_CYCLE);
    expect(first.status).toBe("UP");
    expect(first.changed).toBe(false);
    const second = applyConfirmation(state(first.status, first.consecutiveFailures, 0), PARTIAL_CYCLE);
    expect(second.status).toBe("PARTIAL_OUTAGE");
    expect(second.changed).toBe(true);
  });

  it("requires two clean cycles to recover from DOWN", () => {
    const first = applyConfirmation(state("DOWN", 4, 0), UP_CYCLE);
    expect(first.status).toBe("DOWN");
    expect(first.changed).toBe(false);
    expect(first.consecutiveSuccesses).toBe(1);
    expect(first.consecutiveFailures).toBe(0);

    const second = applyConfirmation(state("DOWN", 0, 1), UP_CYCLE);
    expect(second.status).toBe("UP");
    expect(second.changed).toBe(true);
    expect(second.consecutiveSuccesses).toBe(2);
  });

  it("requires two clean cycles to recover from PARTIAL_OUTAGE", () => {
    const first = applyConfirmation(state("PARTIAL_OUTAGE", 2, 0), UP_CYCLE);
    expect(first.status).toBe("PARTIAL_OUTAGE");
    const second = applyConfirmation(state("PARTIAL_OUTAGE", 0, 1), UP_CYCLE);
    expect(second.status).toBe("UP");
    expect(second.changed).toBe(true);
  });

  it("requires two clean cycles to recover from DEGRADED", () => {
    const first = applyConfirmation(state("DEGRADED", 0, 0), UP_CYCLE);
    expect(first.status).toBe("DEGRADED");
    const second = applyConfirmation(state("DEGRADED", 0, 1), UP_CYCLE);
    expect(second.status).toBe("UP");
  });

  it("promotes a brand new PENDING monitor to UP on its first clean cycle", () => {
    const next = applyConfirmation(state("PENDING"), UP_CYCLE);
    expect(next.status).toBe("UP");
    expect(next.changed).toBe(true);
  });

  it("keeps a PENDING monitor PENDING until a failure is confirmed", () => {
    const first = applyConfirmation(state("PENDING"), DOWN_CYCLE);
    expect(first.status).toBe("PENDING");
    expect(first.consecutiveFailures).toBe(1);
    const second = applyConfirmation(state("PENDING", 1, 0), DOWN_CYCLE);
    expect(second.status).toBe("DOWN");
    expect(second.changed).toBe(true);
  });

  it("keeps counting successes while already UP without flapping `changed`", () => {
    const next = applyConfirmation(state("UP", 0, 9), UP_CYCLE);
    expect(next.status).toBe("UP");
    expect(next.changed).toBe(false);
    expect(next.consecutiveSuccesses).toBe(10);
  });

  it("INCONCLUSIVE freezes both counters and the status", () => {
    const next = applyConfirmation(state("DOWN", 3, 0), INCONCLUSIVE_CYCLE);
    expect(next.status).toBe("DOWN");
    expect(next.consecutiveFailures).toBe(3);
    expect(next.consecutiveSuccesses).toBe(0);
    expect(next.changed).toBe(false);
  });

  it("a bad cycle resets the success streak so recovery restarts from zero", () => {
    const next = applyConfirmation(state("DOWN", 0, 1), DOWN_CYCLE);
    expect(next.consecutiveSuccesses).toBe(0);
  });

  it("honours a stricter confirmation config", () => {
    const strict = { confirmationFailures: 4, confirmationSuccesses: 1 };
    expect(applyConfirmation(state("UP", 2, 0), DOWN_CYCLE, strict).status).toBe("UP");
    expect(applyConfirmation(state("UP", 3, 0), DOWN_CYCLE, strict).status).toBe("DOWN");
    expect(applyConfirmation(state("DOWN", 0, 0), UP_CYCLE, strict).status).toBe("UP");
  });

  it("defaults to two failures and two successes", () => {
    expect(DEFAULT_CONFIRMATION).toEqual({ confirmationFailures: 2, confirmationSuccesses: 2 });
  });
});

// ---------------------------------------------------------------------------
// Region quarantine
// ---------------------------------------------------------------------------

describe("detectQuarantinedRegions", () => {
  it("quarantines the one region failing everything while the world is fine", () => {
    const decisions = detectQuarantinedRegions([
      { regionCode: "bom", totalChecks: 100, failedChecks: 96 },
      { regionCode: "fra", totalChecks: 100, failedChecks: 0 },
      { regionCode: "iad", totalChecks: 100, failedChecks: 1 },
      { regionCode: "sin", totalChecks: 100, failedChecks: 0 },
      { regionCode: "lhr", totalChecks: 100, failedChecks: 0 },
      { regionCode: "sjc", totalChecks: 100, failedChecks: 0 },
      { regionCode: "gru", totalChecks: 100, failedChecks: 0 },
      { regionCode: "syd", totalChecks: 100, failedChecks: 0 },
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.regionCode).toBe("bom");
    expect(decisions[0]?.regionFailureRate).toBeCloseTo(0.96);
    expect(decisions[0]?.peerFailureRate).toBeCloseTo(1 / 700);
    expect(decisions[0]?.reason).toContain("probe-side network fault");
  });

  it("still fires with eight equal regions, where a fleet-wide rate would not", () => {
    // One region failing everything drags the fleet-wide rate to 12.5% > 10%.
    // Judging by peer rate is what keeps this detectable.
    const windows = Array.from({ length: 8 }, (_, i) => ({
      regionCode: `r${i}`,
      totalChecks: 100,
      failedChecks: i === 0 ? 100 : 0,
    }));
    expect(detectQuarantinedRegions(windows).map((d) => d.regionCode)).toEqual(["r0"]);
  });

  it("never quarantines the only region reporting", () => {
    expect(
      detectQuarantinedRegions([{ regionCode: "bom", totalChecks: 100, failedChecks: 100 }]),
    ).toEqual([]);
  });

  it("quarantines nothing during a genuine global outage", () => {
    expect(
      detectQuarantinedRegions([
        { regionCode: "bom", totalChecks: 100, failedChecks: 90 },
        { regionCode: "fra", totalChecks: 100, failedChecks: 88 },
        { regionCode: "iad", totalChecks: 100, failedChecks: 91 },
      ]),
    ).toEqual([]);
  });

  it("ignores a region with too few checks to judge", () => {
    expect(
      detectQuarantinedRegions([
        { regionCode: "bom", totalChecks: 4, failedChecks: 4 },
        { regionCode: "fra", totalChecks: 500, failedChecks: 0 },
        { regionCode: "iad", totalChecks: 500, failedChecks: 0 },
      ]),
    ).toEqual([]);
  });

  it("does not quarantine at exactly the 40% threshold — it must exceed it", () => {
    expect(
      detectQuarantinedRegions([
        { regionCode: "bom", totalChecks: 100, failedChecks: 40 },
        { regionCode: "fra", totalChecks: 1000, failedChecks: 0 },
        { regionCode: "iad", totalChecks: 1000, failedChecks: 0 },
      ]),
    ).toEqual([]);
  });

  it("quarantines just past the threshold", () => {
    const decisions = detectQuarantinedRegions([
      { regionCode: "bom", totalChecks: 100, failedChecks: 41 },
      { regionCode: "fra", totalChecks: 1000, failedChecks: 0 },
      { regionCode: "iad", totalChecks: 1000, failedChecks: 0 },
    ]);
    expect(decisions.map((d) => d.regionCode)).toEqual(["bom"]);
  });

  it("can quarantine two regions at once", () => {
    const decisions = detectQuarantinedRegions([
      { regionCode: "bom", totalChecks: 100, failedChecks: 90 },
      { regionCode: "sin", totalChecks: 100, failedChecks: 85 },
      { regionCode: "fra", totalChecks: 1000, failedChecks: 2 },
      { regionCode: "iad", totalChecks: 1000, failedChecks: 1 },
      { regionCode: "lhr", totalChecks: 1000, failedChecks: 0 },
    ]);
    expect(decisions.map((d) => d.regionCode).sort()).toEqual(["bom", "sin"]);
  });

  it("returns nothing when there is no traffic at all", () => {
    expect(detectQuarantinedRegions([])).toEqual([]);
    expect(detectQuarantinedRegions([{ regionCode: "bom", totalChecks: 0, failedChecks: 0 }])).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Degradation detection
// ---------------------------------------------------------------------------

describe("detectDegradation", () => {
  it("fires when three consecutive buckets exceed 2.5x the baseline", () => {
    const result = detectDegradation(200, [210, 620, 640, 700], null);
    expect(result.thresholdMs).toBe(500);
    expect(result.degraded).toBe(true);
    expect(result.breachingBuckets).toBe(3);
  });

  it("does not fire on normal jitter", () => {
    const result = detectDegradation(200, [180, 240, 210, 260, 190], null);
    expect(result.degraded).toBe(false);
    expect(result.breachingBuckets).toBe(0);
  });

  it("does not fire when only two of the last three buckets breach", () => {
    const result = detectDegradation(200, [900, 900, 210], null);
    expect(result.degraded).toBe(false);
    expect(result.breachingBuckets).toBe(2);
  });

  it("needs a full window before it can fire", () => {
    expect(detectDegradation(200, [900, 900], null).degraded).toBe(false);
  });

  it("applies a floor so very fast endpoints do not alert on microseconds", () => {
    const result = detectDegradation(10, [40, 40, 40], null);
    expect(result.thresholdMs).toBe(150);
    expect(result.degraded).toBe(false);
  });

  it("an explicit threshold overrides the statistical baseline", () => {
    const result = detectDegradation(2000, [600, 700, 800], 500);
    expect(result.thresholdMs).toBe(500);
    expect(result.degraded).toBe(true);
  });

  it("cannot fire without a baseline or an explicit threshold", () => {
    const result = detectDegradation(null, [9000, 9000, 9000], null);
    expect(result.thresholdMs).toBeNull();
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SLO error budget
// ---------------------------------------------------------------------------

describe("computeErrorBudget", () => {
  it("reports a full budget on a perfect window", () => {
    const budget = computeErrorBudget(99.9, 30, 43200, 0, 60);
    expect(budget.actualPercent).toBe(100);
    expect(budget.allowedDowntimeMinutes).toBeCloseTo(43.2, 5);
    expect(budget.consumedDowntimeMinutes).toBe(0);
    expect(budget.remainingPercent).toBe(100);
    expect(budget.breached).toBe(false);
  });

  it("burns budget proportionally to failed checks", () => {
    // 21 failed 60s checks = 21 minutes against a 43.2 minute budget.
    const budget = computeErrorBudget(99.9, 30, 43200, 21, 60);
    expect(budget.consumedDowntimeMinutes).toBe(21);
    expect(budget.remainingPercent).toBeCloseTo(51.4, 1);
    expect(budget.breached).toBe(false);
  });

  it("marks the SLO breached once uptime drops below target", () => {
    const budget = computeErrorBudget(99.9, 30, 43200, 200, 60);
    expect(budget.actualPercent).toBeLessThan(99.9);
    expect(budget.breached).toBe(true);
    expect(budget.remainingPercent).toBeLessThan(0);
  });

  it("clamps a catastrophic overrun to -100 rather than a meaningless number", () => {
    const budget = computeErrorBudget(99.99, 30, 43200, 40000, 60);
    expect(budget.remainingPercent).toBe(-100);
  });

  it("treats an empty window as 100% rather than dividing by zero", () => {
    const budget = computeErrorBudget(99.9, 30, 0, 0, 60);
    expect(budget.actualPercent).toBe(100);
    expect(budget.breached).toBe(false);
  });

  it("a 100% target leaves no budget to spend", () => {
    const budget = computeErrorBudget(100, 30, 1000, 1, 60);
    expect(budget.allowedDowntimeMinutes).toBe(0);
    expect(budget.remainingPercent).toBe(0);
    expect(budget.breached).toBe(true);
  });
});
