import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DbState {
  liveToken: string;
  bucketsWritten: number;
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    bucketsWritten: 0,
    queries: [],
  }),
);

vi.mock("@sentinel/db", () => ({
  sql: {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const text = strings.join("?");
        db.queries.push({ text, values });
        if (text.includes("scheduler_leadership")) {
          return Promise.resolve([{ token: db.liveToken, holder_id: "scheduler-a" }]);
        }
        return Promise.resolve(Array.from({ length: db.bucketsWritten }, () => ({ "?column?": 1 })));
      };
      return run(tx);
    },
  },
  withDbRetry: <T>(operation: () => Promise<T>): Promise<T> => operation(),
}));

const { refreshLatencyBaselines, rollup1h, rollup5m } = await import("./rollups");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

function upsert(table: string): Recorded | undefined {
  return db.queries.find((query) => query.text.includes(`INSERT INTO ${table}`));
}

beforeEach(() => {
  db.liveToken = "7";
  db.bucketsWritten = 0;
  db.queries.length = 0;
});

describe("rollup5m", () => {
  it("reports how many buckets it wrote", async () => {
    db.bucketsWritten = 4;

    await expect(rollup5m(FENCE)).resolves.toBe(4);
  });

  it("recomputes a trailing half hour by default, not just the newest bucket", async () => {
    // Probes land late; a bucket summarised while half its checks were in
    // flight has to be corrected on a later pass.
    await rollup5m(FENCE);

    expect(upsert("check_rollups_5m")?.values).toEqual([30]);
  });

  it("honours a caller-supplied lookback", async () => {
    await rollup5m(FENCE, 120);

    expect(upsert("check_rollups_5m")?.values).toEqual([120]);
  });

  it("corrects an existing bucket rather than failing on it", async () => {
    await rollup5m(FENCE);

    expect(upsert("check_rollups_5m")?.text).toContain(
      "ON CONFLICT (monitor_id, region_code, bucket) DO UPDATE",
    );
  });

  it("reports zero and writes nothing once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.bucketsWritten = 4;

    await expect(rollup5m(FENCE)).resolves.toBe(0);
    expect(upsert("check_rollups_5m")).toBeUndefined();
  });
});

describe("rollup1h", () => {
  it("reports how many hourly buckets it wrote", async () => {
    db.bucketsWritten = 2;

    await expect(rollup1h(FENCE)).resolves.toBe(2);
  });

  it("derives from the 5m table so hourly history outlives raw-check retention", async () => {
    await rollup1h(FENCE);

    const query = upsert("check_rollups_1h");
    expect(query?.text).toContain("FROM check_rollups_5m");
    expect(query?.text).not.toContain("FROM checks");
  });

  it("recomputes three trailing hours by default", async () => {
    await rollup1h(FENCE);

    expect(upsert("check_rollups_1h")?.values).toEqual([3]);
  });

  it("honours a caller-supplied lookback", async () => {
    await rollup1h(FENCE, 12);

    expect(upsert("check_rollups_1h")?.values).toEqual([12]);
  });

  it("reports zero once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.bucketsWritten = 2;

    await expect(rollup1h(FENCE)).resolves.toBe(0);
  });
});

describe("refreshLatencyBaselines", () => {
  it("reports how many baselines it refreshed", async () => {
    db.bucketsWritten = 9;

    await expect(refreshLatencyBaselines(FENCE)).resolves.toBe(9);
  });

  it("reads a seven day window, long enough to absorb a weekly traffic cycle", async () => {
    await refreshLatencyBaselines(FENCE);

    expect(upsert("latency_baselines")?.text).toContain("bucket >= now() - interval '7 days'");
  });

  it("refuses to publish a baseline from too small a sample", async () => {
    await refreshLatencyBaselines(FENCE);

    expect(upsert("latency_baselines")?.text).toContain("HAVING sum(count) >= 30");
  });

  it("reports zero once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.bucketsWritten = 9;

    await expect(refreshLatencyBaselines(FENCE)).resolves.toBe(0);
  });
});
