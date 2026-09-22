import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  dropExpiredPartitions,
  ensurePartitions,
  type PartitionLogger,
  type PartitionSql,
} from "./partitions";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeExecutor {
  readonly tx: PartitionSql;
  readonly queries: RecordedQuery[];
  readonly ddl: string[];
}

/**
 * Models the two call shapes partitions.ts uses: the tagged template for the
 * catalogue read, and `.unsafe()` for DDL — Postgres forbids bind parameters in
 * utility statements, so a fake that pretended `unsafe` were a tagged template
 * would not exercise the code that actually ships.
 *
 * `postgres.TransactionSql` is a forty-odd member interface; the conversion is
 * confined to this one function so the fake stays honest about what it models.
 */
function fakeTransaction(rows: readonly unknown[] = []): FakeExecutor {
  const queries: RecordedQuery[] = [];
  const ddl: string[] = [];

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    queries.push({ text: strings.join("?"), values });
    return Promise.resolve([...rows]);
  };
  const executor = Object.assign(tagged, {
    unsafe: (query: string): Promise<unknown[]> => {
      ddl.push(query);
      return Promise.resolve([]);
    },
  });

  return { tx: executor as unknown as postgres.TransactionSql, queries, ddl };
}

/** The spies are returned alongside the logger so assertions never read a method off it. */
function fakeLogger(): { logger: PartitionLogger; error: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { warn, error }, error };
}

const MARCH_2026 = new Date("2026-03-15T00:00:00.000Z");

describe("ensurePartitions", () => {
  it("covers three months back and one forward by default", async () => {
    const { tx, ddl } = fakeTransaction();

    const created = await ensurePartitions(tx, { now: MARCH_2026 });

    expect(created).toEqual([
      "checks_2025_12",
      "checks_2026_01",
      "checks_2026_02",
      "checks_2026_03",
      "checks_2026_04",
    ]);
    expect(ddl).toHaveLength(5);
  });

  it("emits a half-open monthly range with quoted identifiers", async () => {
    const { tx, ddl } = fakeTransaction();

    await ensurePartitions(tx, { now: MARCH_2026, monthsBack: 0, monthsForward: 0 });

    expect(ddl).toEqual([
      'CREATE TABLE IF NOT EXISTS "checks_2026_03" PARTITION OF checks ' +
        "FOR VALUES FROM ('2026-03-01') TO ('2026-04-01')",
    ]);
  });

  it("pads the month so partitions sort lexicographically", async () => {
    const { tx } = fakeTransaction();

    const created = await ensurePartitions(tx, {
      now: new Date("2026-01-05T00:00:00.000Z"),
      monthsBack: 0,
      monthsForward: 0,
    });

    expect(created).toEqual(["checks_2026_01"]);
  });

  it("rolls the year over rather than producing a thirteenth month", async () => {
    const { tx, ddl } = fakeTransaction();

    const created = await ensurePartitions(tx, {
      now: new Date("2026-12-20T00:00:00.000Z"),
      monthsBack: 0,
      monthsForward: 2,
    });

    expect(created).toEqual(["checks_2026_12", "checks_2027_01", "checks_2027_02"]);
    expect(ddl[0]).toContain("FROM ('2026-12-01') TO ('2027-01-01')");
    expect(ddl[2]).toContain("FROM ('2027-02-01') TO ('2027-03-01')");
  });

  it("is idempotent in SQL, not in application logic", async () => {
    const { tx, ddl } = fakeTransaction();

    await ensurePartitions(tx, { now: MARCH_2026, monthsBack: 0, monthsForward: 0 });

    expect(ddl[0]).toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("refuses to inline a bound that is not YYYY-MM-DD", async () => {
    // A five-digit year makes toISOString() emit "+012026-03-01", which is
    // exactly the shape the guard exists to keep out of a DDL string.
    const { tx, ddl } = fakeTransaction();

    await expect(
      ensurePartitions(tx, {
        now: new Date(Date.UTC(12_026, 2, 15)),
        monthsBack: 0,
        monthsForward: 0,
      }),
    ).rejects.toThrow(/refusing to inline malformed partition bound/);
    expect(ddl).toEqual([]);
  });

  it("refuses to inline a relation name outside the identifier charset", async () => {
    const { tx, ddl } = fakeTransaction();

    await expect(
      ensurePartitions(tx, {
        now: new Date(Date.UTC(-5, 0, 1)),
        monthsBack: 0,
        monthsForward: 0,
      }),
    ).rejects.toThrow(/refusing to inline malformed partition name/);
    expect(ddl).toEqual([]);
  });
});

interface BoundRow {
  readonly child: string;
  readonly upper_bound: string | null;
}

/** `regexp_match(...)[1]` is text, so postgres.js hands these back as strings. */
const BOUNDS: readonly BoundRow[] = [
  { child: "checks_2025_09", upper_bound: "2025-10-01" },
  { child: "checks_2025_11", upper_bound: "2025-12-01" },
  { child: "checks_2025_12", upper_bound: "2026-01-01" },
  { child: "checks_2026_03", upper_bound: "2026-04-01" },
];

const RETENTION_DAYS = 90;

describe("dropExpiredPartitions", () => {
  it("drops only the partitions entirely older than the cutoff", async () => {
    const { tx, ddl } = fakeTransaction(BOUNDS);

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 });

    expect(result.dropped).toEqual(["checks_2025_09", "checks_2025_11"]);
    expect(result.unparseable).toEqual([]);
    expect(ddl).toEqual([
      'DROP TABLE IF EXISTS "checks_2025_09"',
      'DROP TABLE IF EXISTS "checks_2025_11"',
    ]);
  });

  it("drops a partition whose bound lands exactly on the cutoff", async () => {
    // 2026-03-15 minus 90 days is 2025-12-15; the range is half-open, so a
    // partition ending at the cutoff holds nothing inside retention.
    const { tx } = fakeTransaction([{ child: "checks_edge", upper_bound: "2025-12-15" }]);

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 });

    expect(result.dropped).toEqual(["checks_edge"]);
  });

  it("drops nothing when there are no partitions", async () => {
    const { tx, ddl } = fakeTransaction([]);

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 });

    expect(result).toEqual({ dropped: [], unparseable: [] });
    expect(ddl).toEqual([]);
  });

  it("reads the bound out of pg_get_expr rather than guessing from the name", async () => {
    const { tx, queries } = fakeTransaction(BOUNDS);

    await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("pg_get_expr");
    expect(queries[0]?.text).toContain("pg_inherits");
  });
});

describe("dropExpiredPartitions on an unreadable bound", () => {
  it.each([
    ["a NULL bound", null],
    ["a bound the regex could not parse", "not a timestamp"],
    ["an empty bound", ""],
  ])("reports %s instead of silently skipping it", async (_label, upperBound) => {
    const { tx, ddl } = fakeTransaction([{ child: "checks_broken", upper_bound: upperBound }]);
    const { logger, error } = fakeLogger();

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026, logger });

    expect(result.unparseable).toEqual(["checks_broken"]);
    expect(result.dropped).toEqual([]);
    expect(ddl).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { partition: "checks_broken", upperBound },
      expect.stringContaining("never be aged out"),
    );
  });

  it("keeps draining the rest of the batch after an unreadable bound", async () => {
    const { tx, ddl } = fakeTransaction([
      { child: "checks_broken", upper_bound: null },
      ...BOUNDS,
    ]);
    const { logger } = fakeLogger();

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026, logger });

    expect(result.unparseable).toEqual(["checks_broken"]);
    expect(result.dropped).toEqual(["checks_2025_09", "checks_2025_11"]);
    expect(ddl).toHaveLength(2);
  });

  it("falls back to console when the caller injects no logger", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tx } = fakeTransaction([{ child: "checks_broken", upper_bound: null }]);

    const result = await dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 });

    expect(result.unparseable).toEqual(["checks_broken"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("refuses to drop a relation name outside the identifier charset", async () => {
    // relname is a catalogue value, not user input — but it is inlined into DDL,
    // so the guard has to hold even if the catalogue is lying.
    const { tx, ddl } = fakeTransaction([
      { child: 'checks_2020_01"; DROP TABLE users; --', upper_bound: "2020-02-01" },
    ]);

    await expect(dropExpiredPartitions(tx, RETENTION_DAYS, { now: MARCH_2026 })).rejects.toThrow(
      /refusing to inline malformed partition name/,
    );
    expect(ddl).toEqual([]);
  });
});
