import type { DropExpiredResult } from "@sentinel/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { partitionBoundsUnparseable, partitionGaps } from "../metrics";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DbState {
  liveToken: string;
  plans: readonly string[];
  deletedPerPlan: number;
  readonly queries: Recorded[];
  beginCalls: number;
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    plans: [],
    deletedPerPlan: 0,
    queries: [],
    beginCalls: 0,
  }),
);

const partitions = vi.hoisted(() => ({
  ensure: vi.fn((_tx: unknown, _options: unknown) => Promise.resolve<string[]>([])),
  drop: vi.fn((_tx: unknown, _days: number, _options: unknown) =>
    Promise.resolve<DropExpiredResult>({ dropped: [], unparseable: [] }),
  ),
  gaps: vi.fn((_instants: readonly Date[]) => Promise.resolve<string[]>([])),
}));

vi.mock("@sentinel/db", () => ({
  sql: {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      db.beginCalls += 1;
      const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const text = strings.join("?");
        db.queries.push({ text, values });
        if (text.includes("scheduler_leadership")) {
          return Promise.resolve([{ token: db.liveToken, holder_id: "scheduler-a" }]);
        }
        if (text.includes("SELECT DISTINCT plan")) {
          return Promise.resolve(db.plans.map((plan) => ({ plan })));
        }
        // postgres.js reports affected rows on the resolved result, not in a row.
        return Promise.resolve(Object.assign([] as unknown[], { count: db.deletedPerPlan }));
      };
      return run(tx);
    },
  },
  withDbRetry: <T>(operation: () => Promise<T>): Promise<T> => operation(),
  ensurePartitions: partitions.ensure,
  dropExpiredPartitions: partitions.drop,
  findPartitionGaps: partitions.gaps,
}));

const { enforceRawRetention, maintainPartitions } = await import("./retention");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

/** free retains 7 days, pro and business 30 — so 30 is the longest. */
const LONGEST_RETENTION_DAYS = 30;

function deletes(): Recorded[] {
  return db.queries.filter((query) => query.text.includes("DELETE FROM checks"));
}

beforeEach(() => {
  db.liveToken = "7";
  db.plans = [];
  db.deletedPerPlan = 0;
  db.queries.length = 0;
  db.beginCalls = 0;
  partitions.ensure.mockClear();
  partitions.drop.mockClear();
  partitions.gaps.mockClear();
  partitions.drop.mockResolvedValue({ dropped: [], unparseable: [] });
  partitions.gaps.mockResolvedValue([]);
  partitionGaps.reset();
  partitionBoundsUnparseable.reset();
});

describe("enforceRawRetention", () => {
  it("deletes per plan and sums what it removed", async () => {
    db.plans = ["free", "pro"];
    db.deletedPerPlan = 12;

    await expect(enforceRawRetention(FENCE)).resolves.toBe(24);
    expect(deletes()).toHaveLength(2);
  });

  it("gives each plan its own retention window rather than one global figure", async () => {
    db.plans = ["free", "business"];

    await enforceRawRetention(FENCE);

    expect(deletes()[0]?.values).toEqual([7, "free"]);
    expect(deletes()[1]?.values).toEqual([30, "business"]);
  });

  it("falls back to the free window for a plan name it does not recognise", async () => {
    db.plans = ["enterprise-trial"];

    await enforceRawRetention(FENCE);

    expect(deletes()[0]?.values).toEqual([7, "enterprise-trial"]);
  });

  it("deletes nothing when there are no organisations", async () => {
    await expect(enforceRawRetention(FENCE)).resolves.toBe(0);
    expect(deletes()).toEqual([]);
  });

  it("reports zero and deletes nothing once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.plans = ["free"];

    await expect(enforceRawRetention(FENCE)).resolves.toBe(0);
    expect(deletes()).toEqual([]);
  });
});

describe("maintainPartitions", () => {
  it("keeps a month of history and two months of headroom", async () => {
    await maintainPartitions(FENCE);

    expect(partitions.ensure).toHaveBeenCalledWith(expect.anything(), {
      monthsBack: 1,
      monthsForward: 2,
    });
  });

  it("drops against the longest plan retention so no plan loses data early", async () => {
    await maintainPartitions(FENCE);

    expect(partitions.drop).toHaveBeenCalledWith(
      expect.anything(),
      LONGEST_RETENTION_DAYS,
      expect.objectContaining({ logger: expect.anything() }),
    );
  });

  it("runs ensure and drop in separate transactions", async () => {
    // Both take ACCESS EXCLUSIVE on the parent; combining them would hold every
    // probe's insert off for the duration of both.
    await maintainPartitions(FENCE);

    expect(db.beginCalls).toBe(2);
  });

  it("raises the unparseable counter by the number of stuck partitions", async () => {
    partitions.drop.mockResolvedValue({
      dropped: ["checks_2025_09"],
      unparseable: ["checks_legacy", "checks_broken"],
    });

    await maintainPartitions(FENCE);

    const metric = await partitionBoundsUnparseable.get();
    expect(metric.values[0]?.value).toBe(2);
  });

  it("leaves the unparseable counter alone on a clean sweep", async () => {
    partitions.drop.mockResolvedValue({ dropped: ["checks_2025_09"], unparseable: [] });

    await maintainPartitions(FENCE);

    const metric = await partitionBoundsUnparseable.get();
    expect(metric.values[0]?.value ?? 0).toBe(0);
  });

  it("publishes the coverage gap count as a gauge", async () => {
    partitions.gaps.mockResolvedValue(["checks_2026_04"]);

    await maintainPartitions(FENCE);

    const metric = await partitionGaps.get();
    expect(metric.values[0]?.value).toBe(1);
  });

  it("checks this month and next, because there is no DEFAULT partition to catch a miss", async () => {
    await maintainPartitions(FENCE);

    const [instants] = partitions.gaps.mock.calls[0] ?? [];
    expect(instants).toHaveLength(2);
  });

  it("still checks for gaps after being fenced out of the DDL", async () => {
    db.liveToken = "8";

    await maintainPartitions(FENCE);

    expect(partitions.ensure).not.toHaveBeenCalled();
    expect(partitions.gaps).toHaveBeenCalledTimes(1);
  });
});
