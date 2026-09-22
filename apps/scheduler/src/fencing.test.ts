import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFence } from "./fencing";

interface LeadershipRow {
  readonly token: string;
  readonly holder_id: string | null;
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeState {
  rows: readonly LeadershipRow[];
  readonly queries: RecordedQuery[];
  beginCalls: number;
}

const state = vi.hoisted(
  (): FakeState => ({
    rows: [],
    queries: [],
    beginCalls: 0,
  }),
);

vi.mock("@sentinel/db", () => ({
  sql: {
    begin: (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      state.beginCalls += 1;
      const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const text = strings.join("?");
        state.queries.push({ text, values });
        return Promise.resolve(text.includes("scheduler_leadership") ? [...state.rows] : []);
      };
      return run(tx);
    },
  },
}));

const FENCE = { token: 7, holderId: "scheduler-a" } as const;

/**
 * postgres.js hands back bigint columns as strings, and `fencing_token::text`
 * guarantees it here. A fake that returned the number 7 would let a broken
 * `"7" === 7` comparison pass.
 */
function liveRow(token: string, holderId: string | null = "scheduler-a"): LeadershipRow {
  return { token, holder_id: holderId };
}

beforeEach(() => {
  state.rows = [];
  state.queries.length = 0;
  state.beginCalls = 0;
});

describe("withFence while the token is still live", () => {
  it("runs the task and returns its value", async () => {
    state.rows = [liveRow("7")];
    const run = vi.fn(() => Promise.resolve({ dropped: 3 }));

    const result = await withFence(FENCE, "maintainPartitions.drop", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ dropped: 3 });
  });

  it("reads the leadership row inside the same transaction it hands to the task", async () => {
    state.rows = [liveRow("7")];

    await withFence(FENCE, "task", async (tx) => {
      await tx`UPDATE monitor_state SET status = 'UP'`;
      return null;
    });

    expect(state.beginCalls).toBe(1);
    expect(state.queries).toHaveLength(2);
    expect(state.queries[0]?.text).toContain("scheduler_leadership");
    expect(state.queries[0]?.text).toContain("FOR SHARE");
    expect(state.queries[1]?.text).toContain("UPDATE monitor_state");
  });

  it("matches a token that postgres returned with leading zeroes", async () => {
    state.rows = [liveRow("007")];
    const run = vi.fn(() => Promise.resolve("ran"));

    await expect(withFence(FENCE, "task", run)).resolves.toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure from the task rather than reporting it as fenced out", async () => {
    state.rows = [liveRow("7")];
    const boom = new Error("deadlock detected");

    await expect(withFence(FENCE, "task", () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("withFence once the token has moved", () => {
  it.each([
    ["a rival bumped the token", "8"],
    ["the token went backwards", "6"],
    ["the token is wildly ahead", "99999"],
  ])("%s: declines and never invokes the task", async (_label, token) => {
    state.rows = [liveRow(token, "scheduler-b")];
    const run = vi.fn(() => Promise.resolve("must not happen"));

    const result = await withFence(FENCE, "enforceRawRetention", run);

    expect(run).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("declines when the leadership row is gone entirely", async () => {
    state.rows = [];
    const run = vi.fn(() => Promise.resolve("must not happen"));

    const result = await withFence(FENCE, "enforceRawRetention", run);

    expect(run).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("issues no further statements after declining", async () => {
    state.rows = [liveRow("8", "scheduler-b")];

    await withFence(FENCE, "task", async (tx) => {
      await tx`DELETE FROM checks`;
      return null;
    });

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.text).toContain("scheduler_leadership");
  });
});

describe("withFence and a task that legitimately returns nothing", () => {
  it("runs the task even though it will resolve to undefined", async () => {
    state.rows = [liveRow("7")];
    const run = vi.fn(() => Promise.resolve(undefined));

    const result = await withFence(FENCE, "notifySubscribers.fanOut", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  /**
   * DEFECT, reported rather than asserted away: the internal `FencedOutcome`
   * union does distinguish these two, but `withFence` is declared
   * `Promise<T | null>`, so the discriminant is erased at the boundary. A task
   * that legitimately resolves to `null` is indistinguishable from a skip.
   * The only signal left to a caller is that the task never ran.
   */
  it("collapses a null-returning task into the same null a fenced-out call returns", async () => {
    state.rows = [liveRow("7")];
    const ranAndReturnedNull = vi.fn(() => Promise.resolve(null));
    const ranResult = await withFence(FENCE, "task", ranAndReturnedNull);

    state.rows = [liveRow("8", "scheduler-b")];
    const neverRan = vi.fn(() => Promise.resolve(null));
    const fencedResult = await withFence(FENCE, "task", neverRan);

    expect(ranResult).toBeNull();
    expect(fencedResult).toBeNull();
    expect(ranAndReturnedNull).toHaveBeenCalledTimes(1);
    expect(neverRan).not.toHaveBeenCalled();
  });
});
