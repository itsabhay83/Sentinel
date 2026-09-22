import { describe, expect, it, vi } from "vitest";
import {
  consumeRateLimit,
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
  type RateLimitName,
  type RateLimitRedis,
  type RateLimitResult,
} from "./ratelimit";

interface EvalCall {
  script: string;
  numKeys: number;
  args: (string | number)[];
}

function fakeRedis(result: unknown): { redis: RateLimitRedis; calls: EvalCall[] } {
  const calls: EvalCall[] = [];
  return {
    calls,
    redis: {
      eval(script, numKeys, ...args) {
        calls.push({ script, numKeys, args });
        return Promise.resolve(result);
      },
    },
  };
}

function throwingRedis(error: unknown): RateLimitRedis {
  return {
    eval() {
      return Promise.reject(error);
    },
  };
}

describe("consumeRateLimit", () => {
  it("passes the policy through to the script as token-bucket parameters", async () => {
    const { redis, calls } = fakeRedis([1, 119, 0]);

    await consumeRateLimit({ redis, name: "apiRead", subject: "key_123" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.numKeys).toBe(1);

    const [key, capacity, refillPerMs, nowMs, cost, ttlMs] = call.args;
    expect(key).toBe("rl:apiRead:key_123");
    expect(capacity).toBe(120);
    expect(refillPerMs).toBeCloseTo(120 / (60 * 1000), 12);
    expect(Number(nowMs)).toBeGreaterThan(0);
    expect(cost).toBe(1);
    expect(ttlMs).toBe(120_000);
  });

  it("namespaces by policy so one subject's budgets do not collide", async () => {
    const { redis, calls } = fakeRedis([1, 4, 0]);

    await consumeRateLimit({ redis, name: "login", subject: "ip:1.2.3.4" });
    await consumeRateLimit({ redis, name: "signup", subject: "ip:1.2.3.4" });

    expect(calls[0]!.args[0]).toBe("rl:login:ip:1.2.3.4");
    expect(calls[1]!.args[0]).toBe("rl:signup:ip:1.2.3.4");
  });

  it("honours an explicit cost and key prefix", async () => {
    const { redis, calls } = fakeRedis([1, 100, 0]);

    await consumeRateLimit({
      redis,
      name: "apiRead",
      subject: "key_123",
      cost: 20,
      keyPrefix: "tenant42",
    });

    expect(calls[0]!.args[0]).toBe("tenant42:apiRead:key_123");
    expect(calls[0]!.args[4]).toBe(20);
  });

  it("maps an allowed verdict without asking the caller to wait", async () => {
    const { redis } = fakeRedis([1, 9, 0]);

    const result = await consumeRateLimit({ redis, name: "login", subject: "ip:1.2.3.4" });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.retryAfterSeconds).toBe(0);
    expect(result.policy).toEqual(RATE_LIMIT_POLICIES.login);
  });

  it("rounds a denied verdict's wait up to whole seconds", async () => {
    const { redis } = fakeRedis([0, 0, 4_100]);

    const result = await consumeRateLimit({ redis, name: "login", subject: "ip:1.2.3.4" });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(5);
  });

  it("never tells a denied caller to retry in zero seconds", async () => {
    const { redis } = fakeRedis([0, 0, 12]);

    const result = await consumeRateLimit({ redis, name: "login", subject: "ip:1.2.3.4" });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("skips Redis entirely when disabled", async () => {
    const { redis, calls } = fakeRedis([0, 0, 600_000]);

    const result = await consumeRateLimit({
      redis,
      name: "login",
      subject: "ip:1.2.3.4",
      enabled: false,
    });

    expect(calls).toHaveLength(0);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_POLICIES.login.capacity);
  });

  it("fails open and reports the failure when Redis is unreachable", async () => {
    const onError = vi.fn();
    const failure = new Error("ECONNREFUSED");

    const result = await consumeRateLimit({
      redis: throwingRedis(failure),
      name: "login",
      subject: "ip:1.2.3.4",
      onError,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_POLICIES.login.capacity);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it.each([
    ["a non-array reply", "OK"],
    ["a truncated reply", [1, 2]],
    ["a nil reply", null],
  ])("fails open and reports %s from the script", async (_label, reply) => {
    const onError = vi.fn();
    const { redis } = fakeRedis(reply);

    const result = await consumeRateLimit({ redis, name: "login", subject: "s", onError });

    expect(result.allowed).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("RATE_LIMIT_POLICIES", () => {
  const names = Object.keys(RATE_LIMIT_POLICIES) as RateLimitName[];

  it.each(names)("%s is a usable bucket", (name) => {
    const policy = RATE_LIMIT_POLICIES[name];
    expect(policy.capacity).toBeGreaterThan(0);
    expect(policy.refillSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(policy.capacity)).toBe(true);
  });

  it("keeps credential endpoints tighter than machine endpoints", () => {
    const perSecond = (name: RateLimitName) =>
      RATE_LIMIT_POLICIES[name].capacity / RATE_LIMIT_POLICIES[name].refillSeconds;

    expect(perSecond("login")).toBeLessThan(perSecond("apiRead"));
    expect(perSecond("signup")).toBeLessThan(perSecond("login"));
    expect(perSecond("passwordReset")).toBeLessThan(perSecond("login"));
  });
});

describe("rateLimitHeaders", () => {
  const allowed: RateLimitResult = {
    allowed: true,
    remaining: 7,
    retryAfterSeconds: 0,
    policy: RATE_LIMIT_POLICIES.login,
  };

  it("advertises the budget so clients can self-throttle before being denied", () => {
    expect(rateLimitHeaders(allowed)).toEqual({
      "RateLimit-Limit": "10",
      "RateLimit-Remaining": "7",
      "RateLimit-Policy": "10;w=600",
    });
  });

  it("adds Retry-After only when denied", () => {
    const denied = rateLimitHeaders({ ...allowed, allowed: false, retryAfterSeconds: 42 });
    expect(denied["Retry-After"]).toBe("42");
  });

  it("clamps a negative remaining to zero", () => {
    expect(rateLimitHeaders({ ...allowed, remaining: -3 })["RateLimit-Remaining"]).toBe("0");
  });
});
