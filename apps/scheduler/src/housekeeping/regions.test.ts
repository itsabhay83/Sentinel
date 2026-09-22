import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** `count(*)::int` is int4, which postgres.js hands back as a JS number. */
interface StatsRow {
  readonly region_code: string;
  readonly total_checks: number;
  readonly failed_checks: number;
}

interface DbState {
  liveToken: string;
  stats: readonly StatsRow[];
  released: readonly string[];
  flagged: readonly string[];
  readonly queries: Recorded[];
}

const db = vi.hoisted(
  (): DbState => ({
    liveToken: "7",
    stats: [],
    released: [],
    flagged: [],
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
        if (text.includes("count(*) FILTER")) return Promise.resolve([...db.stats]);
        if (text.includes("health_status = 'healthy'")) {
          return Promise.resolve(db.released.map((code) => ({ code })));
        }
        if (text.includes("UPDATE incidents")) {
          return Promise.resolve(db.flagged.map((id) => ({ id })));
        }
        return Promise.resolve([]);
      };
      return run(tx);
    },
  },
  withDbRetry: <T>(operation: () => Promise<T>): Promise<T> => operation(),
}));

const { detectFlapping, updateRegionQuarantine } = await import("./regions");

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

function stats(regionCode: string, totalChecks: number, failedChecks: number): StatsRow {
  return { region_code: regionCode, total_checks: totalChecks, failed_checks: failedChecks };
}

/** One broken probe against a healthy fleet — a probe fault, not an outage. */
const ONE_BAD_REGION: readonly StatsRow[] = [
  stats("bom", 100, 96),
  stats("fra", 100, 0),
  stats("iad", 100, 1),
  stats("sin", 100, 0),
];

const HEALTHY_FLEET: readonly StatsRow[] = [stats("fra", 100, 1), stats("iad", 100, 0)];

function queriesMatching(fragment: string): Recorded[] {
  return db.queries.filter((query) => query.text.includes(fragment));
}

beforeEach(() => {
  db.liveToken = "7";
  db.stats = [];
  db.released = [];
  db.flagged = [];
  db.queries.length = 0;
});

describe("updateRegionQuarantine", () => {
  it("quarantines the region failing far more than its peers", async () => {
    db.stats = ONE_BAD_REGION;

    await expect(updateRegionQuarantine(FENCE)).resolves.toEqual(["bom"]);
  });

  it("records why, so the UI does not show an unexplained quarantine", async () => {
    db.stats = ONE_BAD_REGION;

    await updateRegionQuarantine(FENCE);

    const [update] = queriesMatching("SET health_status = 'quarantined'");
    expect(update?.values[1]).toBe("bom");
    expect(String(update?.values[0])).toContain("probe-side network fault");
  });

  it("quarantines nobody during a genuine global outage", async () => {
    db.stats = [stats("bom", 100, 90), stats("fra", 100, 88), stats("iad", 100, 91)];

    await expect(updateRegionQuarantine(FENCE)).resolves.toEqual([]);
    expect(queriesMatching("SET health_status = 'quarantined'")).toEqual([]);
  });

  it("judges a caller-supplied window rather than a fixed one", async () => {
    await updateRegionQuarantine(FENCE, 45);

    expect(queriesMatching("count(*) FILTER")[0]?.values).toEqual([45]);
  });

  it("excludes the regions it just quarantined from the release sweep", async () => {
    db.stats = ONE_BAD_REGION;

    await updateRegionQuarantine(FENCE);

    expect(queriesMatching("health_status = 'healthy'")[0]?.values).toEqual([["bom"]]);
  });

  it("passes a non-empty sentinel when nothing was quarantined this pass", async () => {
    // postgres.js cannot infer a column type for an empty array literal, and no
    // real region code is the empty string.
    db.stats = HEALTHY_FLEET;

    await updateRegionQuarantine(FENCE);

    expect(queriesMatching("health_status = 'healthy'")[0]?.values).toEqual([[""]]);
  });

  it("releases only quarantines whose window has actually expired", async () => {
    db.released = ["syd"];

    await updateRegionQuarantine(FENCE);

    const [release] = queriesMatching("health_status = 'healthy'");
    expect(release?.text).toContain("quarantined_until <= now()");
  });

  it("refreshes last_seen_at so a silent probe fleet is visible", async () => {
    await updateRegionQuarantine(FENCE);

    expect(queriesMatching("SET last_seen_at = c.last_seen")).toHaveLength(1);
  });

  it("returns an empty list and writes nothing once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.stats = ONE_BAD_REGION;

    await expect(updateRegionQuarantine(FENCE)).resolves.toEqual([]);
    expect(queriesMatching("SET health_status = 'quarantined'")).toEqual([]);
  });
});

describe("detectFlapping", () => {
  it("reports how many incidents it flagged", async () => {
    db.flagged = ["inc-1", "inc-2"];

    await expect(detectFlapping(FENCE)).resolves.toBe(2);
  });

  it("reports zero when nothing is oscillating", async () => {
    await expect(detectFlapping(FENCE)).resolves.toBe(0);
  });

  it("flags only open incidents that are not already flagged", async () => {
    await detectFlapping(FENCE);

    const [update] = queriesMatching("is_flapping");
    expect(update?.text).toContain("i.resolved_at IS NULL");
    expect(update?.text).toContain("i.is_flapping IS DISTINCT FROM 'true'");
  });

  it("needs three incidents inside an hour before calling it flapping", async () => {
    await detectFlapping(FENCE);

    const [update] = queriesMatching("is_flapping");
    expect(update?.text).toContain("p.started_at >= now() - interval '1 hour'");
    expect(update?.text).toContain(">= 3");
  });

  it("reports zero once the fencing token has moved", async () => {
    db.liveToken = "8";
    db.flagged = ["inc-1"];

    await expect(detectFlapping(FENCE)).resolves.toBe(0);
  });
});
