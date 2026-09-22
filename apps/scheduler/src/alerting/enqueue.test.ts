import { beforeEach, describe, expect, it } from "vitest";

import { alertsSuppressed } from "../metrics";
import { fakeTransaction, matching, type RowRouter } from "../testing/fake-sql";
import { queueIncidentAlert, type AlertKind } from "./enqueue";

const ACTIVE_WINDOW = {
  id: "mw-1",
  reason: "database upgrade",
  ends_at: "2026-03-15T14:00:00.000Z",
};

const NO_MAINTENANCE: RowRouter = () => [];

const UNDER_MAINTENANCE: RowRouter = (text) =>
  text.includes("maintenance_windows") ? [ACTIVE_WINDOW] : [];

async function suppressedCount(): Promise<number> {
  const metric = await alertsSuppressed.get();
  return metric.values[0]?.value ?? 0;
}

beforeEach(() => {
  alertsSuppressed.reset();
});

describe("queueIncidentAlert with no maintenance window", () => {
  it.each<AlertKind>(["open", "resolve", "escalate"])("queues a %s alert", async (kind) => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", kind);

    const [insert] = matching(queries, "INSERT INTO alert_deliveries");
    expect(insert?.values).toEqual(["inc-1", kind, 0, 0, "inc-1"]);
  });

  it("defaults to escalation step zero", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    expect(matching(queries, "INSERT INTO alert_deliveries")[0]?.values).toContain(0);
  });

  it("carries a later escalation step into both the select list and the join", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "escalate", 2);

    const [insert] = matching(queries, "INSERT INTO alert_deliveries");
    expect(insert?.values).toEqual(["inc-1", "escalate", 2, 2, "inc-1"]);
    expect(insert?.text).toContain("es.order_index = ?");
  });

  it("resolves a two-scheduler race in Postgres rather than in application code", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    expect(matching(queries, "INSERT INTO alert_deliveries")[0]?.text).toContain(
      "ON CONFLICT DO NOTHING",
    );
  });

  it("fans out across every channel on the step instead of picking one", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    const [insert] = matching(queries, "INSERT INTO alert_deliveries");
    expect(insert?.text).toContain("ch.id = ANY(es.channel_ids)");
  });

  it("leaves the suppression counter alone", async () => {
    const { tx } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    await expect(suppressedCount()).resolves.toBe(0);
  });
});

describe("queueIncidentAlert inside a maintenance window", () => {
  it("skips the insert entirely", async () => {
    const { tx, queries } = fakeTransaction(UNDER_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    expect(queries).toHaveLength(1);
    expect(matching(queries, "INSERT INTO alert_deliveries")).toEqual([]);
  });

  it.each<AlertKind>(["open", "resolve", "escalate"])("suppresses a %s alert", async (kind) => {
    const { tx, queries } = fakeTransaction(UNDER_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", kind, 1);

    expect(matching(queries, "INSERT INTO alert_deliveries")).toEqual([]);
    await expect(suppressedCount()).resolves.toBe(1);
  });

  it("counts every suppressed alert, not just the first", async () => {
    const { tx } = fakeTransaction(UNDER_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");
    await queueIncidentAlert(tx, "inc-2", "open");

    await expect(suppressedCount()).resolves.toBe(2);
  });
});

describe("the maintenance lookup", () => {
  it("is a separate read so the window that swallowed the page can be named", async () => {
    // A NOT EXISTS on the INSERT would suppress just as well but leave no way
    // to tell a suppressed alert from a broken alerter.
    const { tx, queries } = fakeTransaction(UNDER_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    const [lookup] = matching(queries, "maintenance_windows");
    expect(lookup?.values).toEqual(["inc-1"]);
    expect(lookup?.text).toContain("mw.reason");
  });

  it("only counts windows that are scheduled or already running, and only right now", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    const [lookup] = matching(queries, "maintenance_windows");
    expect(lookup?.text).toContain("mw.status IN ('scheduled', 'in_progress')");
    expect(lookup?.text).toContain("now() BETWEEN mw.starts_at AND mw.ends_at");
  });

  it("matches the incident's monitor against the window's monitor list", async () => {
    const { tx, queries } = fakeTransaction(NO_MAINTENANCE);

    await queueIncidentAlert(tx, "inc-1", "open");

    expect(matching(queries, "maintenance_windows")[0]?.text).toContain(
      "i.monitor_id = ANY(mw.monitor_ids)",
    );
  });
});
