import { beforeEach, describe, expect, it, vi } from "vitest";

import { alertDeliveries, alertDeliveriesDead } from "../metrics";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Every timestamp here is read through a scalar subquery in a RETURNING clause,
 * where postgres.js skips its timestamptz parser — so these really are strings.
 */
interface NotificationRow {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
  readonly email: string;
  readonly unsubscribe_token: string;
  readonly page_title: string;
  readonly page_slug: string;
  readonly service_name: string;
  readonly severity: string;
  readonly started_at: string;
  readonly resolved_at: string | null;
}

interface DbState {
  liveToken: string;
  claimed: readonly NotificationRow[];
  failSentUpdate: boolean;
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    claimed: [],
    failSentUpdate: false,
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => {
  const record = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    db.queries.push({ text, values });
    if (text.includes("scheduler_leadership")) {
      return Promise.resolve([{ token: db.liveToken, holder_id: "scheduler-a" }]);
    }
    if (text.includes("SET status = 'sending'")) return Promise.resolve([...db.claimed]);
    if (db.failSentUpdate && text.includes("SET status = 'sent'")) {
      return Promise.reject(new Error("could not serialize access"));
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(record, {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(record),
  });
  return { sql };
});

interface SentMail {
  readonly to: string;
  readonly title: string;
  readonly body: string;
}

const mail = vi.hoisted((): { readonly sent: SentMail[] } => ({ sent: [] }));

/**
 * With no Resend key the transport writes the rendered mail to the log instead
 * of the network, which is the only seam that exposes the composed body.
 */
vi.mock("../logger", () => ({
  logger: {
    info: (payload: Record<string, unknown>): void => {
      const { to, title, body } = payload;
      if (typeof to === "string" && typeof title === "string" && typeof body === "string") {
        mail.sent.push({ to, title, body });
      }
    },
    warn: (): void => undefined,
    error: (): void => undefined,
    debug: (): void => undefined,
  },
}));

const { notifyStatusPageSubscribers } = await import("./subscribers");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

/** Mirrors ALERT_MAX_DELIVERY_ATTEMPTS pinned in vitest.config.ts. */
const MAX_ATTEMPTS = 5;

function notification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "note-1",
    kind: "open",
    attempts: 0,
    email: "watcher@example.test",
    unsubscribe_token: "unsub-token",
    page_title: "Acme Status",
    page_slug: "acme",
    service_name: "Checkout API",
    severity: "down",
    started_at: "2026-03-15T12:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

function queriesMatching(fragment: string): Recorded[] {
  return db.queries.filter((query) => query.text.includes(fragment));
}

function failureWrite(): Recorded | undefined {
  return db.queries.find((query) => query.text.includes("::alert_delivery_status"));
}

beforeEach(() => {
  db.liveToken = "7";
  db.claimed = [];
  db.failSentUpdate = false;
  db.queries.length = 0;
  mail.sent.length = 0;
  alertDeliveries.reset();
  alertDeliveriesDead.reset();
});

describe("notifyStatusPageSubscribers fanning out", () => {
  it("creates the ledger row before any mail leaves", async () => {
    await notifyStatusPageSubscribers(FENCE);

    const fanOutIndex = db.queries.findIndex((query) =>
      query.text.includes("INSERT INTO status_page_notifications"),
    );
    const claimIndex = db.queries.findIndex((query) => query.text.includes("SET status = 'sending'"));
    expect(fanOutIndex).toBeGreaterThanOrEqual(0);
    expect(fanOutIndex).toBeLessThan(claimIndex);
  });

  it("never tells a subscriber about an outage that predates their signup", async () => {
    await notifyStatusPageSubscribers(FENCE);

    const [fanOut] = queriesMatching("INSERT INTO status_page_notifications");
    expect(fanOut?.text).toContain("s.confirmed_at <= i.started_at");
    expect(fanOut?.text).toContain("s.confirmed_at IS NOT NULL");
  });

  it("skips incidents that fell inside a maintenance window", async () => {
    await notifyStatusPageSubscribers(FENCE);

    expect(queriesMatching("INSERT INTO status_page_notifications")[0]?.text).toContain(
      "maintenance_windows",
    );
  });

  it("only fans out for published pages", async () => {
    await notifyStatusPageSubscribers(FENCE);

    expect(queriesMatching("INSERT INTO status_page_notifications")[0]?.text).toContain(
      "p.published = true",
    );
  });

  it("still drains the queue when the fan-out was fenced out", async () => {
    db.liveToken = "8";

    await notifyStatusPageSubscribers(FENCE);

    expect(queriesMatching("INSERT INTO status_page_notifications")).toEqual([]);
    expect(queriesMatching("SET status = 'sending'")).toHaveLength(1);
  });
});

describe("notifyStatusPageSubscribers claiming", () => {
  it("re-claims rows stranded by a scheduler that died mid-flight", async () => {
    await notifyStatusPageSubscribers(FENCE);

    const [claim] = queriesMatching("SET status = 'sending'");
    expect(claim?.values).toContain("5 minutes");
    expect(claim?.text).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("honours the caller's batch limit", async () => {
    await notifyStatusPageSubscribers(FENCE, 25);

    expect(queriesMatching("SET status = 'sending'")[0]?.values).toContain(25);
  });

  it("sends nothing when the queue is empty", async () => {
    await expect(notifyStatusPageSubscribers(FENCE)).resolves.toBe(0);
  });
});

describe("the email a subscriber receives", () => {
  it("marks the row sent and counts it", async () => {
    db.claimed = [notification()];

    await expect(notifyStatusPageSubscribers(FENCE)).resolves.toBe(1);

    expect(queriesMatching("SET status = 'sent'")[0]?.values).toEqual(["note-1"]);
    const metric = await alertDeliveries.get();
    expect(metric.values.find((value) => value.labels["status"] === "sent")?.value).toBe(1);
  });

  it.each([
    ["down", "Outage"],
    ["partial", "Partial outage"],
    ["degraded", "Degraded performance"],
  ])("describes a %s incident as %s", async (severity, label) => {
    db.claimed = [notification({ severity })];

    await notifyStatusPageSubscribers(FENCE);

    expect(mail.sent[0]?.title).toBe(`${label}: Checkout API — Acme Status`);
    expect(mail.sent[0]?.body).toContain(`Impact: ${label}`);
  });

  it("speaks only the page's vocabulary, never the operator's", async () => {
    db.claimed = [notification()];

    await notifyStatusPageSubscribers(FENCE);

    const { to, body } = mail.sent[0] ?? { to: "", body: "" };
    expect(to).toBe("watcher@example.test");
    expect(body).toContain("We are investigating an issue affecting Checkout API.");
    expect(body).toContain("Service: Checkout API");
    expect(body).toContain("Started: Sun, 15 Mar 2026 12:00:00 GMT");
  });

  it("links the live page and an unsubscribe route on every mail", async () => {
    db.claimed = [notification()];

    await notifyStatusPageSubscribers(FENCE);

    expect(mail.sent[0]?.body).toContain("Live status: http://localhost:3000/status/acme");
    expect(mail.sent[0]?.body).toContain(
      "Unsubscribe: http://localhost:3000/status/unsubscribe/unsub-token",
    );
  });

  it("switches to recovery wording once the incident resolved", async () => {
    db.claimed = [
      notification({ kind: "resolve", resolved_at: "2026-03-15T12:30:00.000Z" }),
    ];

    await notifyStatusPageSubscribers(FENCE);

    const { title, body } = mail.sent[0] ?? { title: "", body: "" };
    expect(title).toBe("Resolved: Checkout API — Acme Status");
    expect(body).toContain("Checkout API is working normally again.");
    expect(body).toContain("Resolved: Sun, 15 Mar 2026 12:30:00 GMT");
  });

  it("omits the resolved line when the timestamp is missing", async () => {
    db.claimed = [notification({ kind: "resolve", resolved_at: null })];

    await notifyStatusPageSubscribers(FENCE);

    expect(mail.sent[0]?.body).not.toContain("Resolved: ");
  });

  it("sends one mail per claimed row", async () => {
    db.claimed = [notification({ id: "note-1" }), notification({ id: "note-2", kind: "resolve" })];

    await expect(notifyStatusPageSubscribers(FENCE)).resolves.toBe(2);
    expect(queriesMatching("SET status = 'sent'")).toHaveLength(2);
  });

  it("clears the retry bookkeeping on success", async () => {
    db.claimed = [notification({ attempts: 2 })];

    await notifyStatusPageSubscribers(FENCE);

    expect(queriesMatching("SET status = 'sent'")[0]?.text).toContain("next_attempt_at = NULL");
  });
});

describe("notifyStatusPageSubscribers when a send fails", () => {
  it("schedules a retry rather than dropping the notification", async () => {
    db.failSentUpdate = true;
    db.claimed = [notification({ attempts: 0 })];

    await expect(notifyStatusPageSubscribers(FENCE)).resolves.toBe(0);

    const write = failureWrite();
    expect(write?.values[0]).toBe("failed");
    expect(write?.values[2]).toBe(1);
    expect(Date.parse(String(write?.values[3]))).toBeGreaterThan(Date.now());
  });

  it("gives up only once the attempt budget is spent", async () => {
    db.failSentUpdate = true;
    db.claimed = [notification({ attempts: MAX_ATTEMPTS - 1 })];

    await notifyStatusPageSubscribers(FENCE);

    const write = failureWrite();
    expect(write?.values[0]).toBe("dead");
    expect(write?.values[3]).toBeNull();
    const metric = await alertDeliveriesDead.get();
    expect(metric.values[0]?.value).toBe(1);
  });

  it("keeps working through the rest of the batch", async () => {
    db.failSentUpdate = true;
    db.claimed = [notification({ id: "note-1" }), notification({ id: "note-2" })];

    await notifyStatusPageSubscribers(FENCE);

    expect(queriesMatching("::alert_delivery_status")).toHaveLength(2);
  });

  it("truncates the recorded error so one bad row cannot bloat the table", async () => {
    db.failSentUpdate = true;
    db.claimed = [notification()];

    await notifyStatusPageSubscribers(FENCE);

    expect(String(failureWrite()?.values[1]).length).toBeLessThanOrEqual(500);
  });
});
