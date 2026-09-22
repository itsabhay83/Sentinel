import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAt, retryDelaySeconds } from "./backoff";

/**
 * Every assertion here is a band or a pinned `Math.random`, never a bare
 * equality on a jittered value. The ladder is documented in backoff.ts as
 * 30s → 2m → 8m → 30m → 2h with ±20% jitter, so the bands below are derived
 * from that contract rather than copied from a run.
 */

const JITTER_FLOOR = 0.8;
const JITTER_CEILING = 1.2;

interface Rung {
  readonly attempt: number;
  readonly baseSeconds: number;
}

const LADDER: readonly Rung[] = [
  { attempt: 1, baseSeconds: 30 },
  { attempt: 2, baseSeconds: 120 },
  { attempt: 3, baseSeconds: 480 },
  { attempt: 4, baseSeconds: 1_800 },
  { attempt: 5, baseSeconds: 7_200 },
];

const LAST_RUNG = LADDER[LADDER.length - 1] ?? { attempt: 1, baseSeconds: 30 };

function floorOf(baseSeconds: number): number {
  return Math.round(baseSeconds * JITTER_FLOOR);
}

function ceilingOf(baseSeconds: number): number {
  return Math.round(baseSeconds * JITTER_CEILING);
}

/** Enough samples that a rung escaping its band is overwhelmingly likely to show. */
const SAMPLES = 400;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retryDelaySeconds ladder", () => {
  it.each(LADDER)(
    "attempt $attempt stays inside the ±20% band around $baseSeconds s",
    ({ attempt, baseSeconds }) => {
      for (let i = 0; i < SAMPLES; i += 1) {
        const delay = retryDelaySeconds(attempt);
        expect(delay).toBeGreaterThanOrEqual(floorOf(baseSeconds));
        expect(delay).toBeLessThanOrEqual(ceilingOf(baseSeconds));
      }
    },
  );

  it("actually jitters rather than returning the rung verbatim", () => {
    const seen = new Set<number>();
    for (let i = 0; i < SAMPLES; i += 1) seen.add(retryDelaySeconds(1));
    // A lockstep retry across every channel is exactly what the jitter exists to
    // prevent, so a single observed value would be the failure, not a flake.
    expect(seen.size).toBeGreaterThan(1);
  });

  it.each(LADDER)(
    "attempt $attempt bottoms out at 0.8 × $baseSeconds when the jitter rolls lowest",
    ({ attempt, baseSeconds }) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(retryDelaySeconds(attempt)).toBe(floorOf(baseSeconds));
    },
  );

  it.each(LADDER)(
    "attempt $attempt tops out at 1.2 × $baseSeconds when the jitter rolls highest",
    ({ attempt, baseSeconds }) => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      expect(retryDelaySeconds(attempt)).toBe(ceilingOf(baseSeconds));
    },
  );

  it("is monotonically non-decreasing across the ladder", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delays = LADDER.map((rung) => retryDelaySeconds(rung.attempt));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    }
  });

  it("widens by more than the jitter can close, so the rungs never overlap", () => {
    // Worst case: this rung rolls its ceiling and the next rolls its floor.
    for (let i = 1; i < LADDER.length; i += 1) {
      const previous = LADDER[i - 1];
      const current = LADDER[i];
      if (!previous || !current) continue;
      expect(floorOf(current.baseSeconds)).toBeGreaterThan(ceilingOf(previous.baseSeconds));
    }
  });
});

describe("retryDelaySeconds clamping", () => {
  it.each([
    ["one past the last rung", LAST_RUNG.attempt + 1],
    ["far past the last rung", 50],
    ["absurdly past the last rung", Number.MAX_SAFE_INTEGER],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("%s clamps to the last rung instead of growing", (_label, attempt) => {
    // 0.8 + 0.5 × 0.4 === 1.0, so the jitter factor is exactly one here.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(retryDelaySeconds(attempt)).toBe(LAST_RUNG.baseSeconds);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["absurdly negative", Number.MIN_SAFE_INTEGER],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("%s clamps up to the first rung instead of throwing", (_label, attempt) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(retryDelaySeconds(attempt)).toBe(30);
  });

  it("returns a finite positive delay for NaN rather than NaN", () => {
    // NaN survives both clamps and indexes the ladder with NaN; the `??`
    // fallback in backoff.ts is what keeps this a number.
    const delay = retryDelaySeconds(Number.NaN);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
  });

  it("returns a finite positive delay for a fractional attempt", () => {
    // A fractional index misses every rung and falls back to the first one, so
    // attempt 4.5 is delayed like attempt 1. Production attempts come from an
    // integer column, so this is a sharp edge rather than a live defect.
    for (const attempt of [1.5, 4.5]) {
      const delay = retryDelaySeconds(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});

describe("retryAt", () => {
  it("offsets the given instant by the delay, in milliseconds", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const from = new Date("2026-03-01T12:00:00.000Z");

    const at = retryAt(2, from);

    expect(at.getTime() - from.getTime()).toBe(retryDelaySeconds(2) * 1_000);
  });

  it("does not mutate the instant it was handed", () => {
    const from = new Date("2026-03-01T12:00:00.000Z");
    const before = from.getTime();

    retryAt(3, from);

    expect(from.getTime()).toBe(before);
  });

  it.each(LADDER)("attempt $attempt lands inside its band ahead of `from`", ({ attempt, baseSeconds }) => {
    const from = new Date("2026-03-01T12:00:00.000Z");

    const aheadSeconds = (retryAt(attempt, from).getTime() - from.getTime()) / 1_000;

    expect(aheadSeconds).toBeGreaterThanOrEqual(floorOf(baseSeconds));
    expect(aheadSeconds).toBeLessThanOrEqual(ceilingOf(baseSeconds));
  });

  it("defaults to now, so a caller that omits `from` still schedules into the future", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const before = Date.now();

    const at = retryAt(1);

    const aheadMs = at.getTime() - before;
    expect(aheadMs).toBeGreaterThanOrEqual(floorOf(30) * 1_000);
    expect(aheadMs).toBeLessThanOrEqual(ceilingOf(30) * 1_000);
  });
});
