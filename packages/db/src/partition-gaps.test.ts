import { beforeEach, describe, expect, it, vi } from "vitest";
import { findPartitionGaps, listPartitions } from "./partitions";

interface Catalogue {
  partitions: readonly string[];
  readonly queries: string[];
}

const catalogue = vi.hoisted(
  (): Catalogue => ({
    partitions: [],
    queries: [],
  }),
);

/**
 * `listPartitions` reads the shared pool directly — there is no executor
 * parameter to inject, so the pool module is the only seam available.
 */
vi.mock("./client", () => ({
  sql: (strings: TemplateStringsArray): Promise<{ child: string }[]> => {
    catalogue.queries.push(strings.join("?"));
    return Promise.resolve(catalogue.partitions.map((child) => ({ child })));
  },
}));

beforeEach(() => {
  catalogue.partitions = [];
  catalogue.queries.length = 0;
});

describe("listPartitions", () => {
  it("returns the child relation names the catalogue reported", async () => {
    catalogue.partitions = ["checks_2026_01", "checks_2026_02"];

    await expect(listPartitions()).resolves.toEqual(["checks_2026_01", "checks_2026_02"]);
  });

  it("walks pg_inherits from the `checks` parent", async () => {
    await listPartitions();

    expect(catalogue.queries).toHaveLength(1);
    expect(catalogue.queries[0]).toContain("pg_inherits");
    expect(catalogue.queries[0]).toContain("parent.relname = 'checks'");
  });
});

describe("findPartitionGaps", () => {
  it("names the month an instant needs when no partition covers it", async () => {
    catalogue.partitions = ["checks_2026_01"];

    await expect(findPartitionGaps([new Date("2026-03-15T00:00:00.000Z")])).resolves.toEqual([
      "checks_2026_03",
    ]);
  });

  it("reports nothing when every instant is covered", async () => {
    catalogue.partitions = ["checks_2026_03", "checks_2026_04"];

    await expect(
      findPartitionGaps([
        new Date("2026-03-15T00:00:00.000Z"),
        new Date("2026-04-01T00:00:00.000Z"),
      ]),
    ).resolves.toEqual([]);
  });

  it("names a missing month once even when several instants fall in it", async () => {
    await expect(
      findPartitionGaps([
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-15T00:00:00.000Z"),
        new Date("2026-03-31T23:59:59.000Z"),
      ]),
    ).resolves.toEqual(["checks_2026_03"]);
  });

  it("reports every missing month, not just the first", async () => {
    catalogue.partitions = ["checks_2026_03"];

    await expect(
      findPartitionGaps([
        new Date("2026-03-15T00:00:00.000Z"),
        new Date("2026-04-01T00:00:00.000Z"),
        new Date("2026-05-01T00:00:00.000Z"),
      ]),
    ).resolves.toEqual(["checks_2026_04", "checks_2026_05"]);
  });

  it.each([
    ["just after a UTC month starts", "2026-03-01T00:30:00.000Z"],
    ["just before a UTC month ends", "2026-03-31T23:30:00.000Z"],
  ])("buckets an instant %s by its UTC month, not the host timezone", async (_label, instant) => {
    // checked_at is timestamptz and partitions are cut on UTC boundaries, so a
    // host in UTC-5 or UTC+9 must still resolve these to March.
    await expect(findPartitionGaps([new Date(instant)])).resolves.toEqual(["checks_2026_03"]);
  });

  it("reports nothing when asked about no instants at all", async () => {
    await expect(findPartitionGaps([])).resolves.toEqual([]);
  });
});
