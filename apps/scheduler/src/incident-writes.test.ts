import { beforeEach, describe, expect, it } from "vitest";
import { evaluateConsensus, type FailureCode, type RegionResult } from "@sentinel/shared";

import type { CycleRow } from "./cycles";
import { applyIncidentTransition } from "./incident-writes";
import { alertsSuppressed, incidentsOpened } from "./metrics";
import { fakeTransaction, matching, type RowRouter } from "./testing/fake-sql";

const MAINTENANCE_WINDOW = {
  id: "mw-1",
  reason: "database upgrade",
  ends_at: "2026-03-15T14:00:00.000Z",
};

interface Routes {
  /** `null` models a RETURNING clause that produced no row. */
  readonly newIncidentId: string | null;
  readonly underMaintenance: boolean;
}

function routes(overrides: Partial<Routes> = {}): RowRouter {
  const { newIncidentId = "inc-new", underMaintenance = false } = overrides;
  return (text) => {
    if (text.includes("maintenance_windows")) return underMaintenance ? [MAINTENANCE_WINDOW] : [];
    if (text.includes("INSERT INTO incidents")) {
      return newIncidentId === null ? [] : [{ id: newIncidentId }];
    }
    return [];
  };
}

function bad(regionCode: string, failureCode: FailureCode = "HTTP_5XX"): RegionResult {
  return { regionCode, ok: false, failureCode, totalMs: 0 };
}

function ok(regionCode: string): RegionResult {
  return { regionCode, ok: true, failureCode: null, totalMs: 120 };
}

const DOWN_CONSENSUS = evaluateConsensus([bad("bom"), bad("fra"), bad("iad")]);
const UP_CONSENSUS = evaluateConsensus([ok("bom"), ok("fra"), ok("iad")]);

const AT = new Date("2026-03-15T12:00:00.000Z");

/** `quorum_ratio` is numeric in Postgres, and postgres.js returns numerics as strings. */
function cycleRow(overrides: Partial<CycleRow> = {}): CycleRow {
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
    results: [],
    oldest_check: new Date("2026-03-15T11:59:00.000Z"),
    ...overrides,
  };
}

async function openedCount(severity: string): Promise<number> {
  const metric = await incidentsOpened.get();
  return metric.values.find((value) => value.labels["severity"] === severity)?.value ?? 0;
}

beforeEach(() => {
  incidentsOpened.reset();
  alertsSuppressed.reset();
});

describe("applyIncidentTransition opening an incident", () => {
  it.each([
    ["DOWN", "down"],
    ["PARTIAL_OUTAGE", "partial"],
    ["DEGRADED", "degraded"],
  ] as const)("maps %s to severity %s and opens an incident", async (status, severity) => {
    const { tx, queries } = fakeTransaction(routes());

    await applyIncidentTransition(tx, { row: cycleRow(), status, consensus: DOWN_CONSENSUS, at: AT });

    const [insert] = matching(queries, "INSERT INTO incidents");
    expect(insert?.values).toEqual([
      "mon-1",
      AT.toISOString(),
      severity,
      "HTTP_5XX",
      ["bom", "fra", "iad"],
    ]);
    await expect(openedCount(severity)).resolves.toBe(1);
  });

  it("records the opening event and points monitor_state at the new incident", async () => {
    const { tx, queries } = fakeTransaction(routes({ newIncidentId: "inc-42" }));

    await applyIncidentTransition(tx, {
      row: cycleRow(),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    const [event] = matching(queries, "INSERT INTO incident_events");
    expect(event?.values[0]).toBe("inc-42");
    expect(event?.values[2]).toContain('"quorumThreshold":2');
    expect(event?.values[2]).toContain('"cycleId":"cyc-1"');
    expect(matching(queries, "UPDATE monitor_state")[0]?.values).toEqual(["inc-42", "mon-1"]);
  });

  it("queues exactly one open alert for the incident it just created", async () => {
    const { tx, queries } = fakeTransaction(routes({ newIncidentId: "inc-42" }));

    await applyIncidentTransition(tx, {
      row: cycleRow(),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    const alerts = matching(queries, "INSERT INTO alert_deliveries");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values).toEqual(["inc-42", "open", 0, 0, "inc-42"]);
  });

  it("stops cleanly when the INSERT returns no row rather than writing orphan rows", async () => {
    const { tx, queries } = fakeTransaction(routes({ newIncidentId: null }));

    await applyIncidentTransition(tx, {
      row: cycleRow(),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    expect(queries).toHaveLength(1);
    await expect(openedCount("down")).resolves.toBe(0);
  });

  it("opens the incident even while maintenance suppresses the page", async () => {
    const { tx, queries } = fakeTransaction(routes({ underMaintenance: true }));

    await applyIncidentTransition(tx, {
      row: cycleRow(),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    expect(matching(queries, "INSERT INTO incidents")).toHaveLength(1);
    expect(matching(queries, "INSERT INTO alert_deliveries")).toEqual([]);
  });
});

describe("applyIncidentTransition on an incident that already exists", () => {
  it("changes severity in place instead of opening a second incident", async () => {
    const { tx, queries } = fakeTransaction(routes());

    await applyIncidentTransition(tx, {
      row: cycleRow({ current_incident_id: "inc-1", status: "PARTIAL_OUTAGE" }),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    expect(matching(queries, "INSERT INTO incidents")).toEqual([]);
    const [update] = matching(queries, "UPDATE incidents SET severity");
    expect(update?.values).toEqual(["down", ["bom", "fra", "iad"], "inc-1"]);
    expect(matching(queries, "INSERT INTO incident_events")[0]?.values[2]).toContain(
      '"status":"DOWN"',
    );
  });

  it("does not re-page on a severity change", async () => {
    // The channels were notified when the incident opened; re-paging is
    // escalation's job, on its own timer.
    const { tx, queries } = fakeTransaction(routes());

    await applyIncidentTransition(tx, {
      row: cycleRow({ current_incident_id: "inc-1" }),
      status: "DOWN",
      consensus: DOWN_CONSENSUS,
      at: AT,
    });

    expect(matching(queries, "INSERT INTO alert_deliveries")).toEqual([]);
    await expect(openedCount("down")).resolves.toBe(0);
  });
});

describe("applyIncidentTransition resolving an incident", () => {
  it("resolves, clears monitor_state and queues the resolve alert", async () => {
    const { tx, queries } = fakeTransaction(routes());

    await applyIncidentTransition(tx, {
      row: cycleRow({ current_incident_id: "inc-1", status: "DOWN" }),
      status: "UP",
      consensus: UP_CONSENSUS,
      at: AT,
    });

    const [resolved] = matching(queries, "UPDATE incidents SET resolved_at");
    expect(resolved?.values).toEqual([AT.toISOString(), "inc-1"]);
    // Re-resolving must be a no-op, so the guard belongs in the WHERE clause.
    expect(resolved?.text).toContain("resolved_at IS NULL");
    expect(matching(queries, "UPDATE monitor_state")[0]?.values).toEqual(["mon-1"]);
    expect(matching(queries, "INSERT INTO alert_deliveries")[0]?.values).toEqual([
      "inc-1",
      "resolve",
      0,
      0,
      "inc-1",
    ]);
  });

  it.each(["UP", "PENDING", "INCONCLUSIVE"] as const)(
    "writes nothing when %s arrives with no open incident",
    async (status) => {
      const { tx, queries } = fakeTransaction(routes());

      await applyIncidentTransition(tx, {
        row: cycleRow(),
        status,
        consensus: UP_CONSENSUS,
        at: AT,
      });

      expect(queries).toEqual([]);
    },
  );
});
