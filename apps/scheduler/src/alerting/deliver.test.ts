import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alertDeliveries, alertDeliveriesDead } from "../metrics";
import type { PendingDelivery } from "./transports";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DbState {
  claimed: readonly PendingDelivery[];
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    claimed: [],
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    db.queries.push({ text, values });
    return Promise.resolve(text.includes("SET status = 'sending'") ? [...db.claimed] : []);
  },
  withDbRetry: <T>(operation: () => Promise<T>): Promise<T> => operation(),
}));

const { deliverPendingAlerts } = await import("./deliver");

/** Mirrors ALERT_MAX_DELIVERY_ATTEMPTS pinned in vitest.config.ts. */
const MAX_ATTEMPTS = 5;

let fetchStatus = 200;

function pending(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: "del-1",
    kind: "open",
    step_index: 0,
    attempts: 0,
    channel_kind: "webhook",
    channel_name: "ops",
    config: { url: "https://hooks.example.test/sentinel" },
    incident_id: "inc-1",
    severity: "down",
    started_at: "2026-03-15T12:00:00.000Z",
    resolved_at: null,
    primary_failure_code: "HTTP_5XX",
    affected_regions: ["bom"],
    monitor_id: "mon-1",
    monitor_name: "API — checkout",
    monitor_url: "https://api.example.test/checkout",
    ...overrides,
  };
}

function writesTo(id: string): Recorded[] {
  return db.queries.filter(
    (query) => !query.text.includes("SET status = 'sending'") && query.values.includes(id),
  );
}

async function statusCount(status: string): Promise<number> {
  const metric = await alertDeliveries.get();
  return metric.values.find((value) => value.labels["status"] === status)?.value ?? 0;
}

beforeEach(() => {
  db.claimed = [];
  db.queries.length = 0;
  fetchStatus = 200;
  alertDeliveries.reset();
  alertDeliveriesDead.reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("body", { status: fetchStatus }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deliverPendingAlerts claiming", () => {
  it("returns zero and writes nothing when nothing is due", async () => {
    await expect(deliverPendingAlerts()).resolves.toBe(0);
    expect(db.queries).toHaveLength(1);
  });

  it("re-claims rows stranded by a scheduler that died mid-flight", async () => {
    await deliverPendingAlerts();

    const [claim] = db.queries;
    expect(claim?.text).toContain("status = 'sending' AND attempted_at <= now() - ?::interval");
    expect(claim?.values).toContain("5 minutes");
    expect(claim?.text).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("honours the caller's batch limit", async () => {
    await deliverPendingAlerts(7);

    expect(db.queries[0]?.values).toContain(7);
  });
});

describe("deliverPendingAlerts on success", () => {
  it("marks the row sent with the transport's status code", async () => {
    db.claimed = [pending({ attempts: 2 })];

    await expect(deliverPendingAlerts()).resolves.toBe(1);

    const [update] = writesTo("del-1");
    expect(update?.text).toContain("SET status = 'sent'");
    expect(update?.values).toEqual([200, 3, "del-1"]);
    await expect(statusCount("sent")).resolves.toBe(1);
  });

  it("counts every row in the batch", async () => {
    db.claimed = [pending({ id: "del-1" }), pending({ id: "del-2" })];

    await expect(deliverPendingAlerts()).resolves.toBe(2);
  });
});

describe("deliverPendingAlerts on a transport failure", () => {
  it("schedules a retry rather than treating one failure as terminal", async () => {
    fetchStatus = 503;
    db.claimed = [pending({ attempts: 0 })];

    await expect(deliverPendingAlerts()).resolves.toBe(0);

    const [update] = writesTo("del-1");
    expect(update?.values[0]).toBe("failed");
    expect(update?.values[2]).toBe(1);
    expect(String(update?.values[1])).toContain("503");
    const nextAttemptAt = String(update?.values[3]);
    expect(Date.parse(nextAttemptAt)).toBeGreaterThan(Date.now());
    await expect(statusCount("failed")).resolves.toBe(1);
  });

  it("declares the page dead only once the attempt budget is spent", async () => {
    fetchStatus = 503;
    db.claimed = [pending({ attempts: MAX_ATTEMPTS - 1 })];

    await deliverPendingAlerts();

    const [update] = writesTo("del-1");
    expect(update?.values[0]).toBe("dead");
    expect(update?.values[2]).toBe(MAX_ATTEMPTS);
    // A dead row must not be re-claimed, so it carries no next attempt.
    expect(update?.values[3]).toBeNull();
    await expect(statusCount("dead")).resolves.toBe(1);
  });

  it("raises the dedicated dead counter an operator can alert on", async () => {
    fetchStatus = 503;
    db.claimed = [pending({ attempts: MAX_ATTEMPTS - 1 })];

    await deliverPendingAlerts();

    const metric = await alertDeliveriesDead.get();
    expect(metric.values[0]?.value).toBe(1);
  });

  it("keeps delivering the rest of the batch after one channel fails", async () => {
    db.claimed = [
      pending({ id: "del-1", channel_kind: "webhook", config: {} }),
      pending({ id: "del-2", channel_kind: "email", config: { to: "ops@example.test" } }),
    ];

    await expect(deliverPendingAlerts()).resolves.toBe(1);

    expect(writesTo("del-1")[0]?.values[0]).toBe("failed");
    expect(writesTo("del-2")[0]?.text).toContain("SET status = 'sent'");
  });

  it("truncates a pathological error body so one bad channel cannot bloat the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("x".repeat(2_000)))),
    );
    db.claimed = [pending()];

    await deliverPendingAlerts();

    expect(String(writesTo("del-1")[0]?.values[1])).toHaveLength(500);
  });
});
