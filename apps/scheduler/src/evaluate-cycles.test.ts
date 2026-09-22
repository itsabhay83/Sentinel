import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorStatus, RegionResult } from "@sentinel/shared";

import type { CycleRow } from "./cycles";

/** Split from evaluate.test.ts, which covers the pure `statusFor` seam. */

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DbState {
  pending: readonly CycleRow[];
  lockAcquired: boolean;
  failOnMonitor: string | null;
  readonly queries: Recorded[];
  beginCalls: number;
}

const db = vi.hoisted(
  (): DbState => ({
    pending: [],
    lockAcquired: true,
    failOnMonitor: null,
    queries: [],
    beginCalls: 0,
  }),
);

vi.mock("@sentinel/db", () => {
  const record = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    db.queries.push({ text, values });
    if (text.includes("JOIN LATERAL")) return Promise.resolve([...db.pending]);
    if (text.includes("pg_try_advisory_xact_lock")) {
      return Promise.resolve([{ ok: db.lockAcquired }]);
    }
    if (
      db.failOnMonitor !== null &&
      text.includes("UPDATE monitor_state SET") &&
      values.includes(db.failOnMonitor)
    ) {
      return Promise.reject(new Error("deadlock detected"));
    }
    if (text.includes("INSERT INTO incidents")) return Promise.resolve([{ id: "inc-new" }]);
    return Promise.resolve([]);
  };
  const sql = Object.assign(record, {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      db.beginCalls += 1;
      return run(record);
    },
  });
  return { sql };
});

const { evaluatePendingCycles } = await import("./evaluate");

const NOW = new Date("2026-03-15T12:00:00.000Z");
const CYCLE_GRACE_MS = 20_000;

function ok(regionCode: string, totalMs = 120): RegionResult {
  return { regionCode, ok: true, failureCode: null, totalMs };
}

function bad(regionCode: string): RegionResult {
  return { regionCode, ok: false, failureCode: "HTTP_5XX", totalMs: 0 };
}

/** `quorum_ratio` is numeric, which postgres.js returns as a string. */
function cycle(overrides: Partial<CycleRow> = {}): CycleRow {
  return {
    monitor_id: "mon-1",
    cycle_id: "cyc-1",
    quorum_ratio: "0.6",
    min_regions_required: 2,
    confirmation_failures: 2,
    confirmation_successes: 2,
    degraded_threshold_ms: null,
    status: "UP",
    consecutive_failures: 0,
    consecutive_successes: 0,
    current_incident_id: null,
    expected_regions: 3,
    results: [ok("bom"), ok("fra"), ok("iad")],
    oldest_check: new Date(NOW.getTime() - 1_000),
    ...overrides,
  };
}

function stateWrite(): Recorded | undefined {
  return db.queries.find((query) => query.text.includes("UPDATE monitor_state SET"));
}

function writtenStatus(): unknown {
  return stateWrite()?.values[0];
}

beforeEach(() => {
  db.pending = [];
  db.lockAcquired = true;
  db.failOnMonitor = null;
  db.queries.length = 0;
  db.beginCalls = 0;
});

describe("evaluatePendingCycles deciding when a cycle is ripe", () => {
  it("waits for a straggler while the grace window is still open", async () => {
    db.pending = [cycle({ expected_regions: 3, results: [ok("bom")] })];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(0);
    expect(db.beginCalls).toBe(0);
  });

  it("judges on partial data once the grace window lapses", async () => {
    db.pending = [
      cycle({
        expected_regions: 3,
        results: [bad("bom"), bad("fra")],
        oldest_check: new Date(NOW.getTime() - CYCLE_GRACE_MS - 1),
        status: "UP",
        consecutive_failures: 1,
      }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(writtenStatus()).toBe("DOWN");
  });

  it("judges immediately once every expected region has reported", async () => {
    db.pending = [cycle({ expected_regions: 3, status: "PENDING" })];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(writtenStatus()).toBe("UP");
  });

  it("treats a null result set as no regions reporting", async () => {
    db.pending = [cycle({ results: null as unknown as RegionResult[], expected_regions: 0 })];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(0);
  });
});

describe("evaluatePendingCycles under the advisory lock", () => {
  it("writes nothing when a peer already holds the monitor's lock", async () => {
    db.lockAcquired = false;
    db.pending = [cycle({ results: [bad("bom"), bad("fra"), bad("iad")], consecutive_failures: 1 })];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(stateWrite()).toBeUndefined();
  });

  it("takes the lock per monitor, inside the same transaction as the write", async () => {
    db.pending = [cycle()];

    await evaluatePendingCycles(NOW);

    expect(db.beginCalls).toBe(1);
    expect(db.queries.filter((q) => q.text.includes("pg_try_advisory_xact_lock"))).toHaveLength(1);
  });
});

describe("evaluatePendingCycles confirmation damping", () => {
  it("holds UP on the first failing cycle", async () => {
    db.pending = [
      cycle({ results: [bad("bom"), bad("fra"), bad("iad")], consecutive_failures: 0 }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(0);
    expect(writtenStatus()).toBe("UP");
    expect(stateWrite()?.values).toContain(1);
  });

  it("declares DOWN on the second failing cycle and opens an incident", async () => {
    db.pending = [
      cycle({ results: [bad("bom"), bad("fra"), bad("iad")], consecutive_failures: 1 }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(writtenStatus()).toBe("DOWN");
    expect(db.queries.some((q) => q.text.includes("INSERT INTO incidents"))).toBe(true);
  });

  it("leaves the incident ledger alone when nothing changed", async () => {
    db.pending = [cycle({ status: "UP", consecutive_successes: 5 })];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(0);
    expect(db.queries.some((q) => q.text.includes("INSERT INTO incidents"))).toBe(false);
  });
});

describe("evaluatePendingCycles layering degradation on a healthy verdict", () => {
  it("reports DEGRADED without pushing the monitor through the failure counters", async () => {
    // Slowness must not open a DOWN incident for a site that is answering.
    db.pending = [
      cycle({
        results: [ok("bom", 900), ok("fra", 950), ok("iad", 1_000)],
        degraded_threshold_ms: 500,
      }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(writtenStatus()).toBe("DEGRADED");
    expect(stateWrite()?.values).toContain(0);
  });

  it("recovers to UP once latency returns inside the threshold", async () => {
    db.pending = [
      cycle({
        status: "DEGRADED",
        consecutive_successes: 1,
        results: [ok("bom", 100), ok("fra", 120), ok("iad", 110)],
        degraded_threshold_ms: 500,
      }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
    expect(writtenStatus()).toBe("UP");
  });
});

describe("evaluatePendingCycles recording evidence", () => {
  it("stores the median latency of the regions that actually answered", async () => {
    db.pending = [cycle({ results: [bad("gru"), ok("bom", 100), ok("fra", 300), ok("iad", 200)] })];

    await evaluatePendingCycles(NOW);

    expect(stateWrite()?.values).toContain(200);
  });

  it("stores no latency when no region answered", async () => {
    db.pending = [
      cycle({ results: [bad("bom"), bad("fra"), bad("iad")], consecutive_failures: 1 }),
    ];

    await evaluatePendingCycles(NOW);

    expect(stateWrite()?.values).toContain(null);
  });

  it("names the failing regions so the UI can explain the verdict", async () => {
    db.pending = [cycle({ results: [bad("bom"), ok("fra"), ok("iad")] })];

    await evaluatePendingCycles(NOW);

    expect(stateWrite()?.values).toContainEqual(["bom"]);
  });

  it("clears the cycle id so the row is not re-evaluated", async () => {
    db.pending = [cycle()];

    await evaluatePendingCycles(NOW);

    expect(stateWrite()?.text).toContain("current_cycle_id = NULL");
  });
});

describe("evaluatePendingCycles isolating failures", () => {
  it("keeps evaluating the rest of the batch when one monitor throws", async () => {
    db.failOnMonitor = "mon-1";
    db.pending = [
      cycle({ monitor_id: "mon-1", status: "PENDING" }),
      cycle({ monitor_id: "mon-2", status: "PENDING" }),
    ];

    await expect(evaluatePendingCycles(NOW)).resolves.toBe(1);
  });

  it.each(["UP", "DOWN", "PENDING"] as const)(
    "counts a transition only when the status actually moves from %s",
    async (status: MonitorStatus) => {
      db.pending = [cycle({ status, consecutive_successes: 5 })];

      const transitions = await evaluatePendingCycles(NOW);

      expect(transitions).toBe(status === "UP" ? 0 : 1);
    },
  );
});
