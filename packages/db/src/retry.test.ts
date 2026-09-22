import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDbRetry } from "./retry";

/** Mirrors DB_MAX_RETRIES pinned in vitest.config.ts. */
const MAX_RETRIES = 3;
const MAX_ATTEMPTS = MAX_RETRIES + 1;

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres reported ${code}`), { code });
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Attaches both handlers synchronously so a rejection never escapes as an
 * unhandled promise while the fake clock is being advanced.
 */
function settle<T>(operation: () => Promise<T>, label?: string): Promise<Outcome<T>> {
  const promise = label === undefined ? withDbRetry(operation) : withDbRetry(operation, label);
  return promise.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

async function drain<T>(operation: () => Promise<T>, label?: string): Promise<Outcome<T>> {
  const settled = settle(operation, label);
  await vi.runAllTimersAsync();
  return settled;
}

function failingTimes(failure: unknown, times: number, value = "row") {
  let calls = 0;
  return vi.fn((): Promise<string> => {
    calls += 1;
    return calls <= times ? Promise.reject(failure) : Promise.resolve(value);
  });
}

const RETRYABLE_CODES = [
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57P01",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08006",
  "08P01",
] as const;

const NON_RETRYABLE_CODES = ["23505", "23503", "22P02", "42601", "42P01", "57014", "0A000"] as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withDbRetry on success", () => {
  it("runs the operation exactly once and returns its value", async () => {
    const operation = vi.fn(() => Promise.resolve({ id: 7 }));

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, value: { id: 7 } });
  });

  it("returns the value produced by the second attempt", async () => {
    const operation = failingTimes(sqlError("40001"), 1, "second-attempt-row");

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ ok: true, value: "second-attempt-row" });
  });

  it("recovers on the last permitted attempt", async () => {
    const operation = failingTimes(sqlError("57P03"), MAX_RETRIES, "recovered");

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(outcome).toEqual({ ok: true, value: "recovered" });
  });
});

describe("withDbRetry on transient failures", () => {
  it.each(RETRYABLE_CODES)("retries SQLSTATE %s", async (code) => {
    const operation = failingTimes(sqlError(code), 1);

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ ok: true, value: "row" });
  });

  it("waits on the backoff timer instead of spinning", async () => {
    // Math.random() === 1 makes the first backoff exactly min(2000, 100 * 2^0).
    vi.spyOn(Math, "random").mockReturnValue(1);
    const operation = failingTimes(sqlError("40001"), 1);

    const settled = settle(operation);
    await vi.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await expect(settled).resolves.toEqual({ ok: true, value: "row" });
  });

  it("widens the backoff between attempts rather than retrying at a fixed rate", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const operation = failingTimes(sqlError("40001"), MAX_RETRIES, "recovered");

    const settled = settle(operation);
    await vi.advanceTimersByTimeAsync(100);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(operation).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    await expect(settled).resolves.toEqual({ ok: true, value: "recovered" });
  });
});

describe("withDbRetry on deterministic failures", () => {
  it.each(NON_RETRYABLE_CODES)("rethrows SQLSTATE %s untouched after one attempt", async (code) => {
    const failure = sqlError(code);
    const operation = vi.fn(() => Promise.reject(failure));

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe(failure);
    expect(outcome.error).toHaveProperty("code", code);
  });

  it.each([
    ["an error with no code at all", new Error("boom")],
    ["an error whose code is a number", Object.assign(new Error("boom"), { code: 40001 })],
    ["an error whose code is null", Object.assign(new Error("boom"), { code: null })],
    ["a thrown string", "not an error"],
    ["a thrown null", null],
    ["a thrown plain object", { detail: "no code here" }],
  ])("rethrows %s untouched after one attempt", async (_label, failure) => {
    const operation = vi.fn(() => Promise.reject(failure));

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe(failure);
  });

  it("does not treat a code that merely contains 08 as a connection failure", async () => {
    const failure = sqlError("22P08");
    const operation = vi.fn(() => Promise.reject(failure));

    const outcome = await drain(operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
  });
});

describe("withDbRetry on exhaustion", () => {
  it("stops after the configured attempt count and reports it accurately", async () => {
    const failure = sqlError("40P01");
    const operation = vi.fn(() => Promise.reject(failure));

    const outcome = await drain(operation, "claim due monitors");

    expect(operation).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(Error);
    if (!(outcome.error instanceof Error)) return;
    expect(outcome.error.message).toBe(
      `Database claim due monitors failed after ${MAX_ATTEMPTS} attempt(s)`,
    );
  });

  it("carries the last transient error as the cause rather than discarding it", async () => {
    const first = sqlError("40001");
    const last = sqlError("57P01");
    let calls = 0;
    const operation = vi.fn(() => {
      calls += 1;
      return Promise.reject(calls < MAX_ATTEMPTS ? first : last);
    });

    const outcome = await drain(operation);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (!(outcome.error instanceof Error)) return;
    expect(outcome.error.cause).toBe(last);
  });

  it("defaults the label to 'query' when the caller names nothing", async () => {
    const operation = vi.fn(() => Promise.reject(sqlError("08006")));

    const outcome = await drain(operation);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (!(outcome.error instanceof Error)) return;
    expect(outcome.error.message).toBe(`Database query failed after ${MAX_ATTEMPTS} attempt(s)`);
  });

  it("wraps rather than rethrowing, so the SQLSTATE is not mistaken for a fresh failure", async () => {
    const failure = sqlError("55P03");
    const operation = vi.fn(() => Promise.reject(failure));

    const outcome = await drain(operation);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).not.toBe(failure);
    expect(outcome.error).not.toHaveProperty("code");
  });
});
