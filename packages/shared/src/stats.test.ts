import { describe, expect, it } from "vitest";
import { bucketStart, formatDuration, percentile, summarize, uptimePercent } from "./stats";

interface PercentileCase {
  readonly name: string;
  readonly values: readonly number[];
  readonly p: number;
  readonly expected: number | null;
}

/** 1..10, deliberately shuffled — percentile must sort a copy, not trust the caller. */
const SHUFFLED_TEN: readonly number[] = [7, 2, 9, 4, 1, 10, 3, 8, 5, 6];

const PERCENTILES: readonly PercentileCase[] = [
  { name: "an empty sample has no percentile", values: [], p: 50, expected: null },
  { name: "an empty sample has no p99 either", values: [], p: 99, expected: null },
  { name: "a single element answers every percentile", values: [42], p: 50, expected: 42 },
  { name: "a single element answers p0", values: [42], p: 0, expected: 42 },
  { name: "a single element answers p100", values: [42], p: 100, expected: 42 },
  { name: "p0 clamps to the smallest value rather than underflowing", values: SHUFFLED_TEN, p: 0, expected: 1 },
  { name: "p100 is the largest value", values: SHUFFLED_TEN, p: 100, expected: 10 },
  { name: "p50 of ten takes the fifth rank", values: SHUFFLED_TEN, p: 50, expected: 5 },
  { name: "p95 of ten rounds its rank up to ten", values: SHUFFLED_TEN, p: 95, expected: 10 },
  { name: "p10 lands exactly on the first rank", values: SHUFFLED_TEN, p: 10, expected: 1 },
  { name: "p25 of four lands exactly on the first rank", values: [40, 10, 30, 20], p: 25, expected: 10 },
  { name: "p50 of four lands exactly on the second rank", values: [40, 10, 30, 20], p: 50, expected: 20 },
  { name: "p75 of four lands exactly on the third rank", values: [40, 10, 30, 20], p: 75, expected: 30 },
  { name: "duplicates do not shift the rank", values: [5, 5, 5, 9], p: 50, expected: 5 },
  { name: "duplicates still surface the outlier at p100", values: [5, 5, 5, 9], p: 100, expected: 9 },
  { name: "an all-identical sample is flat", values: [3, 3, 3], p: 95, expected: 3 },
  { name: "negative values sort numerically, not lexically", values: [-5, -100, -20], p: 0, expected: -100 },
  { name: "numeric sort places 100 above 9", values: [9, 100, 80], p: 100, expected: 100 },
];

describe("percentile", () => {
  it.each(PERCENTILES)("$name", ({ values, p, expected }) => {
    expect(percentile(values, p)).toBe(expected);
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it("is monotonically non-decreasing across p", () => {
    const sample = Array.from({ length: 100 }, (_, i) => i + 1);
    let previous = Number.NEGATIVE_INFINITY;
    for (let p = 0; p <= 100; p += 1) {
      const value = percentile(sample, p);
      expect(value).not.toBeNull();
      expect(value ?? 0).toBeGreaterThanOrEqual(previous);
      previous = value ?? 0;
    }
  });
});

describe("summarize", () => {
  it("reports nothing but a zero count for an empty sample", () => {
    expect(summarize([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
  });

  it("collapses a single observation onto every statistic", () => {
    expect(summarize([120])).toEqual({ count: 1, p50: 120, p95: 120, p99: 120, max: 120 });
  });

  it("agrees with percentile on an unsorted sample", () => {
    const values = SHUFFLED_TEN;
    expect(summarize(values)).toEqual({
      count: 10,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
      max: 10,
    });
  });

  it("counts duplicates rather than deduplicating them", () => {
    expect(summarize([7, 7, 7]).count).toBe(3);
  });
});

describe("bucketStart", () => {
  it("floors into the containing five-minute bucket", () => {
    const at = new Date("2026-03-05T10:07:42.500Z");
    expect(bucketStart(at, 5).toISOString()).toBe("2026-03-05T10:05:00.000Z");
  });

  it("leaves an instant that is already a bucket boundary alone", () => {
    const at = new Date("2026-03-05T10:05:00.000Z");
    expect(bucketStart(at, 5).toISOString()).toBe("2026-03-05T10:05:00.000Z");
  });

  it("floors into the containing hour bucket", () => {
    const at = new Date("2026-03-05T10:59:59.999Z");
    expect(bucketStart(at, 60).toISOString()).toBe("2026-03-05T10:00:00.000Z");
  });

  it("crosses midnight downwards rather than clamping to the day", () => {
    const at = new Date("2026-03-05T00:03:00.000Z");
    expect(bucketStart(at, 60).toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("returns a new Date instead of mutating the input", () => {
    const at = new Date("2026-03-05T10:07:42.500Z");
    const bucketed = bucketStart(at, 5);
    expect(bucketed).not.toBe(at);
    expect(at.toISOString()).toBe("2026-03-05T10:07:42.500Z");
  });

  it("floors instants before the epoch downwards too", () => {
    const at = new Date("1969-12-31T23:57:30.000Z");
    expect(bucketStart(at, 5).toISOString()).toBe("1969-12-31T23:55:00.000Z");
  });
});

describe("uptimePercent", () => {
  it("reports a perfect score when nothing was checked", () => {
    // A monitor with no samples has not proven itself down; 0/0 must not be NaN.
    expect(uptimePercent(0, 0)).toBe(100);
  });

  it("reports a perfect score when every check passed", () => {
    expect(uptimePercent(288, 288)).toBe(100);
  });

  it("reports zero when every check failed", () => {
    expect(uptimePercent(288, 0)).toBe(0);
  });

  it("reports the ratio as a percentage", () => {
    expect(uptimePercent(200, 199)).toBeCloseTo(99.5, 10);
  });

  it("does not round a repeating ratio", () => {
    expect(uptimePercent(3, 1)).toBeCloseTo(33.3333, 4);
  });
});

interface DurationCase {
  readonly ms: number;
  readonly expected: string;
}

const DURATIONS: readonly DurationCase[] = [
  { ms: 0, expected: "0ms" },
  { ms: 1, expected: "1ms" },
  { ms: 450, expected: "450ms" },
  { ms: 999, expected: "999ms" },
  { ms: 1_000, expected: "1s" },
  { ms: 1_999, expected: "1s" },
  { ms: 59_000, expected: "59s" },
  { ms: 59_999, expected: "59s" },
  { ms: 60_000, expected: "1m 0s" },
  { ms: 90_000, expected: "1m 30s" },
  { ms: 3_599_000, expected: "59m 59s" },
  { ms: 3_600_000, expected: "1h 0m" },
  { ms: 3_720_000, expected: "1h 2m" },
  { ms: 86_399_000, expected: "23h 59m" },
  { ms: 86_400_000, expected: "1d 0h" },
  { ms: 90_000_000, expected: "1d 1h" },
  { ms: 864_000_000, expected: "10d 0h" },
];

describe("formatDuration", () => {
  it.each(DURATIONS)("renders $ms ms as $expected", ({ ms, expected }) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("rounds sub-second values to whole milliseconds", () => {
    expect(formatDuration(12.4)).toBe("12ms");
  });
});
