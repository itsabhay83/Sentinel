import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DueRow {
  readonly incident_id: string;
  readonly order_index: number;
}

interface DbState {
  liveToken: string;
  due: readonly DueRow[];
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    due: [],
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => {
  const route = (text: string): unknown[] => {
    if (text.includes("scheduler_leadership")) {
      return [{ token: db.liveToken, holder_id: "scheduler-a" }];
    }
    return text.includes("AS incident_id") ? [...db.due] : [];
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

const { escalateOpenIncidents } = await import("./escalate");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

function queriesMatching(fragment: string): Recorded[] {
  return db.queries.filter((query) => query.text.includes(fragment));
}

beforeEach(() => {
  db.liveToken = "7";
  db.due = [];
  db.queries.length = 0;
});

describe("escalateOpenIncidents selecting work", () => {
  it("escalates nothing and opens no transaction when nothing is due", async () => {
    await expect(escalateOpenIncidents(FENCE)).resolves.toBe(0);
    expect(queriesMatching("scheduler_leadership")).toEqual([]);
  });

  it("skips step zero, which the incident already paged on when it opened", async () => {
    await escalateOpenIncidents(FENCE);

    expect(queriesMatching("AS incident_id")[0]?.text).toContain("es.order_index > 0");
  });

  it("ignores incidents that are resolved or acknowledged", async () => {
    await escalateOpenIncidents(FENCE);

    const [due] = queriesMatching("AS incident_id");
    expect(due?.text).toContain("i.resolved_at IS NULL");
    expect(due?.text).toContain("i.acknowledged_at IS NULL");
  });

  it("waits for the step's own delay before it fires", async () => {
    await escalateOpenIncidents(FENCE);

    expect(queriesMatching("AS incident_id")[0]?.text).toContain(
      "i.started_at + make_interval(mins => es.after_minutes) <= now()",
    );
  });

  it("re-reads idempotently by excluding steps already delivered", async () => {
    await escalateOpenIncidents(FENCE);

    const [due] = queriesMatching("AS incident_id");
    expect(due?.text).toContain("NOT EXISTS");
    expect(due?.text).toContain("d.kind = 'escalate'");
  });
});

describe("escalateOpenIncidents advancing a step", () => {
  it("queues the page for that step and records the event", async () => {
    db.due = [{ incident_id: "inc-1", order_index: 2 }];

    await expect(escalateOpenIncidents(FENCE)).resolves.toBe(1);

    expect(queriesMatching("INSERT INTO alert_deliveries")[0]?.values).toEqual([
      "inc-1",
      "escalate",
      2,
      2,
      "inc-1",
    ]);
    const [event] = queriesMatching("INSERT INTO incident_events");
    expect(event?.values[0]).toBe("inc-1");
    expect(event?.values[1]).toBe('{"step":2}');
  });

  it("fences each incident separately so a mid-sweep takeover is caught", async () => {
    db.due = [
      { incident_id: "inc-1", order_index: 1 },
      { incident_id: "inc-2", order_index: 1 },
    ];

    await expect(escalateOpenIncidents(FENCE)).resolves.toBe(2);
    expect(queriesMatching("scheduler_leadership")).toHaveLength(2);
  });
});

describe("escalateOpenIncidents under a lost fence", () => {
  it("stops the sweep at the first refusal instead of retrying every row", async () => {
    db.liveToken = "8";
    db.due = [
      { incident_id: "inc-1", order_index: 1 },
      { incident_id: "inc-2", order_index: 1 },
      { incident_id: "inc-3", order_index: 1 },
    ];

    await expect(escalateOpenIncidents(FENCE)).resolves.toBe(0);
    expect(queriesMatching("scheduler_leadership")).toHaveLength(1);
    expect(queriesMatching("INSERT INTO incident_events")).toEqual([]);
  });
});
