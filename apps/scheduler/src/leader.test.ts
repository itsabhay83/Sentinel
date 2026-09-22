import type postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INSTANCE_ID, LeaderElection } from "./leader";

interface ClientState {
  lockGranted: boolean;
  backendPid: number;
  /** `fencing_token::text`, so postgres.js hands this back as a string. */
  bumpedToken: string | null;
  stillHoldsLock: boolean;
  heartbeatRows: number;
  failNextWith: Error | null;
  readonly queries: string[];
  ended: boolean;
}

const state = vi.hoisted(
  (): ClientState => ({
    lockGranted: true,
    backendPid: 4242,
    bumpedToken: "5",
    stillHoldsLock: true,
    heartbeatRows: 1,
    failNextWith: null,
    queries: [],
    ended: false,
  }),
);

function rowsFor(text: string): unknown[] {
  if (text.includes("pg_try_advisory_lock")) {
    return [{ locked: state.lockGranted, pid: state.backendPid }];
  }
  if (text.includes("INSERT INTO scheduler_leadership")) {
    return state.bumpedToken === null ? [] : [{ token: state.bumpedToken }];
  }
  if (text.includes("pg_locks")) {
    return [{ pid: state.backendPid, holds: state.stillHoldsLock }];
  }
  return [];
}

vi.mock("@sentinel/db", () => {
  const client = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join("?");
    state.queries.push(text);
    if (state.failNextWith !== null) {
      const failure = state.failNextWith;
      state.failNextWith = null;
      return Promise.reject(failure);
    }
    // postgres.js resolves to an array carrying `count`; the heartbeat reads it.
    return Promise.resolve(Object.assign(rowsFor(text), { count: state.heartbeatRows }));
  };
  client.end = (): Promise<void> => {
    state.ended = true;
    return Promise.resolve();
  };
  return { createDedicatedClient: (): postgres.Sql => client as unknown as postgres.Sql };
});

function issued(fragment: string): number {
  return state.queries.filter((text) => text.includes(fragment)).length;
}

beforeEach(() => {
  state.lockGranted = true;
  state.backendPid = 4242;
  state.bumpedToken = "5";
  state.stillHoldsLock = true;
  state.heartbeatRows = 1;
  state.failNextWith = null;
  state.queries.length = 0;
  state.ended = false;
});

describe("INSTANCE_ID", () => {
  it("names the host and the process so a log line identifies the writer", () => {
    expect(INSTANCE_ID).toContain(`-${process.pid}-`);
    expect(INSTANCE_ID).toMatch(/-[0-9a-f]{6}$/);
  });
});

describe("LeaderElection acquiring leadership", () => {
  it("returns the bumped token and this instance as the holder", async () => {
    const election = new LeaderElection();

    await expect(election.tryAcquire()).resolves.toEqual({ token: 5, holderId: INSTANCE_ID });
    expect(election.isLeader).toBe(true);
    expect(election.currentFence).toEqual({ token: 5, holderId: INSTANCE_ID });
  });

  it("stands down without bumping anything when the advisory lock is taken", async () => {
    state.lockGranted = false;
    const election = new LeaderElection();

    await expect(election.tryAcquire()).resolves.toBeNull();
    expect(election.isLeader).toBe(false);
    expect(issued("INSERT INTO scheduler_leadership")).toBe(0);
  });

  it.each([
    ["the register returned no row", null],
    ["the token is not a number", "not-a-token"],
    ["the token exceeds the safe integer range", "9007199254740993"],
  ])("hands the advisory lock straight back when %s", async (_label, token) => {
    state.bumpedToken = token;
    const election = new LeaderElection();

    await expect(election.tryAcquire()).resolves.toBeNull();
    expect(election.isLeader).toBe(false);
    // Holding a lock it cannot use would keep every healthy peer out until the
    // session ends.
    expect(issued("pg_advisory_unlock")).toBe(1);
  });

  it("stands down rather than assuming leadership when the query itself fails", async () => {
    state.failNextWith = new Error("connection terminated unexpectedly");
    const election = new LeaderElection();

    await expect(election.tryAcquire()).resolves.toBeNull();
    expect(election.isLeader).toBe(false);
  });
});

describe("LeaderElection re-proving leadership each tick", () => {
  async function elected(): Promise<LeaderElection> {
    const election = new LeaderElection();
    await election.tryAcquire();
    state.queries.length = 0;
    return election;
  }

  it("re-reads pg_locks instead of trusting the cached fence", async () => {
    const election = await elected();

    await election.tryAcquire();

    expect(issued("pg_locks")).toBe(1);
  });

  it("keeps the same token, so writers in flight are not fenced off needlessly", async () => {
    const election = await elected();

    await expect(election.tryAcquire()).resolves.toEqual({ token: 5, holderId: INSTANCE_ID });
    expect(issued("INSERT INTO scheduler_leadership")).toBe(0);
  });

  it("heartbeats against its own token and holder id", async () => {
    const election = await elected();

    await election.tryAcquire();

    expect(issued("UPDATE scheduler_leadership")).toBe(1);
  });

  it("loses leadership when the session no longer holds the advisory lock", async () => {
    const election = await elected();
    state.stillHoldsLock = false;

    await expect(election.tryAcquire()).resolves.toBeNull();
    expect(election.isLeader).toBe(false);
  });

  it("loses leadership when the register no longer names this instance", async () => {
    const election = await elected();
    state.heartbeatRows = 0;

    await expect(election.tryAcquire()).resolves.toBeNull();
    expect(election.currentFence).toBeNull();
  });

  it("re-acquires from scratch on the tick after it stood down", async () => {
    const election = await elected();
    state.stillHoldsLock = false;
    await election.tryAcquire();

    state.stillHoldsLock = true;
    state.bumpedToken = "6";
    state.queries.length = 0;

    await expect(election.tryAcquire()).resolves.toEqual({ token: 6, holderId: INSTANCE_ID });
    expect(issued("pg_try_advisory_lock")).toBe(1);
  });
});

describe("LeaderElection releasing", () => {
  it("unlocks and closes the dedicated session", async () => {
    const election = new LeaderElection();
    await election.tryAcquire();
    state.queries.length = 0;

    await election.release();

    expect(issued("pg_advisory_unlock")).toBe(1);
    expect(election.isLeader).toBe(false);
    expect(state.ended).toBe(true);
  });

  it("closes the session without unlocking when it never led", async () => {
    state.lockGranted = false;
    const election = new LeaderElection();
    await election.tryAcquire();
    state.queries.length = 0;

    await election.release();

    expect(issued("pg_advisory_unlock")).toBe(0);
    expect(state.ended).toBe(true);
  });

  it("still closes the session when the unlock statement fails", async () => {
    const election = new LeaderElection();
    await election.tryAcquire();
    state.failNextWith = new Error("connection already closed");

    await election.release();

    expect(state.ended).toBe(true);
  });
});
