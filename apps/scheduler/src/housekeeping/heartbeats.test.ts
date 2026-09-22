import { beforeEach, describe, expect, it, vi } from "vitest";

import { incidentsOpened } from "../metrics";

/** Split from incidents.test.ts, which covers the certificate half of the module. */

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface HeartbeatRow {
  readonly monitor_id: string;
  readonly status: string;
  readonly current_incident_id: string | null;
  readonly is_late: boolean;
}

interface DbState {
  liveToken: string;
  heartbeats: readonly HeartbeatRow[];
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    heartbeats: [],
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => {
  const route = (text: string): unknown[] => {
    if (text.includes("scheduler_leadership")) {
      return [{ token: db.liveToken, holder_id: "scheduler-a" }];
    }
    if (text.includes("FROM heartbeats h")) return [...db.heartbeats];
    if (text.includes("INSERT INTO incidents")) return [{ id: "inc-new" }];
    return [];
  };
  const record = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    db.queries.push({ text, values });
    return Promise.resolve(route(text));
  };
  const sql = Object.assign(record, {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(record),
  });
  return { sql };
});

const { checkHeartbeats } = await import("./incidents");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

function heartbeat(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    monitor_id: "mon-1",
    status: "UP",
    current_incident_id: null,
    is_late: false,
    ...overrides,
  };
}

function queriesMatching(fragment: string): Recorded[] {
  return db.queries.filter((query) => query.text.includes(fragment));
}

beforeEach(() => {
  db.liveToken = "7";
  db.heartbeats = [];
  db.queries.length = 0;
  incidentsOpened.reset();
});

describe("checkHeartbeats opening", () => {
  it("opens a DOWN incident once the ping is overdue", async () => {
    db.heartbeats = [heartbeat({ is_late: true })];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(1);

    expect(queriesMatching("INSERT INTO incidents")[0]?.text).toContain("'HEARTBEAT_MISSED'");
    expect(queriesMatching("UPDATE monitor_state")[0]?.text).toContain("status = 'DOWN'");
  });

  it("explains the absence rather than leaving a bare code in the timeline", async () => {
    db.heartbeats = [heartbeat({ is_late: true })];

    await checkHeartbeats(FENCE);

    expect(String(queriesMatching("INSERT INTO incident_events")[0]?.values[1])).toContain(
      "reason",
    );
  });

  it("pages on the new incident and counts it as a down incident", async () => {
    db.heartbeats = [heartbeat({ is_late: true })];

    await checkHeartbeats(FENCE);

    expect(queriesMatching("INSERT INTO alert_deliveries")[0]?.values).toEqual([
      "inc-new",
      "open",
      0,
      0,
      "inc-new",
    ]);
    const metric = await incidentsOpened.get();
    expect(metric.values.find((value) => value.labels["severity"] === "down")?.value).toBe(1);
  });

  it("opens from PENDING as readily as from UP", async () => {
    db.heartbeats = [heartbeat({ is_late: true, status: "PENDING" })];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(1);
  });
});

describe("checkHeartbeats resolving", () => {
  it("closes the open incident the moment a ping arrives", async () => {
    db.heartbeats = [heartbeat({ status: "DOWN", current_incident_id: "inc-1" })];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(1);

    const [resolved] = queriesMatching("UPDATE incidents SET resolved_at");
    expect(resolved?.values).toEqual(["inc-1"]);
    expect(resolved?.text).toContain("resolved_at IS NULL");
    expect(queriesMatching("UPDATE monitor_state")[0]?.text).toContain("status = 'UP'");
  });

  it("queues the resolve page", async () => {
    db.heartbeats = [heartbeat({ status: "DOWN", current_incident_id: "inc-1" })];

    await checkHeartbeats(FENCE);

    expect(queriesMatching("INSERT INTO alert_deliveries")[0]?.values).toContain("resolve");
  });

  it("recovers a monitor that is DOWN with no incident attached", async () => {
    db.heartbeats = [heartbeat({ status: "DOWN", current_incident_id: null })];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(1);

    expect(queriesMatching("UPDATE incidents SET resolved_at")).toEqual([]);
    expect(queriesMatching("UPDATE monitor_state")[0]?.text).toContain("status = 'UP'");
  });
});

describe("checkHeartbeats leaving settled monitors alone", () => {
  it.each([
    ["already DOWN and still overdue", "DOWN", true],
    ["already UP and pinging", "UP", false],
    ["DEGRADED and pinging", "DEGRADED", false],
  ])("writes nothing for a monitor %s", async (_label, status, isLate) => {
    db.heartbeats = [heartbeat({ status, is_late: isLate })];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(0);
    expect(queriesMatching("UPDATE monitor_state")).toEqual([]);
  });
});

describe("checkHeartbeats across a batch", () => {
  it("counts every monitor that actually changed state", async () => {
    db.heartbeats = [
      heartbeat({ monitor_id: "mon-1", is_late: true }),
      heartbeat({ monitor_id: "mon-2", status: "UP", is_late: false }),
      heartbeat({ monitor_id: "mon-3", status: "DOWN", current_incident_id: "inc-3" }),
    ];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(2);
  });

  it("abandons the sweep rather than pressing on without leadership", async () => {
    db.liveToken = "8";
    db.heartbeats = [
      heartbeat({ monitor_id: "mon-1", is_late: true }),
      heartbeat({ monitor_id: "mon-2", is_late: true }),
    ];

    await expect(checkHeartbeats(FENCE)).resolves.toBe(0);
    expect(queriesMatching("scheduler_leadership")).toHaveLength(1);
  });
});
