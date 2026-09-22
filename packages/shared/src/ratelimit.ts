/**
 * Redis token-bucket rate limiting.
 *
 * Token bucket rather than a fixed window because a fixed window lets a caller
 * spend the whole budget in the last millisecond of window N and the whole
 * budget again in the first millisecond of window N+1 — a 2x burst past the
 * stated limit, which is exactly what a credential-stuffing script exploits.
 *
 * The Redis client is injected as a structural type so this package does not
 * take an ioredis dependency; every app already owns a configured client.
 */

export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RateLimitPolicy {
  /** Maximum burst size. */
  capacity: number;
  /** Sustained rate: `capacity` tokens are restored over this many seconds. */
  refillSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  policy: RateLimitPolicy;
}

/**
 * Atomic because check-then-write from the application would let concurrent
 * requests each read the same token count and all decide they are allowed.
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts = tonumber(stored[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = nowMs - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HSET', key, 'tokens', tokens, 'ts', nowMs)
redis.call('PEXPIRE', key, ttlMs)

local retryAfterMs = 0
if allowed == 0 then
  retryAfterMs = math.ceil((cost - tokens) / refillPerMs)
end

return { allowed, math.floor(tokens), retryAfterMs }
`;

export const RATE_LIMIT_POLICIES = {
  login: { capacity: 10, refillSeconds: 600 },
  signup: { capacity: 5, refillSeconds: 3_600 },
  passwordReset: { capacity: 5, refillSeconds: 3_600 },
  emailVerification: { capacity: 5, refillSeconds: 3_600 },
  mfaVerify: { capacity: 10, refillSeconds: 600 },
  apiRead: { capacity: 120, refillSeconds: 60 },
  apiWrite: { capacity: 30, refillSeconds: 60 },
  heartbeat: { capacity: 60, refillSeconds: 60 },
  statusSubscribe: { capacity: 5, refillSeconds: 3_600 },
  statusGate: { capacity: 20, refillSeconds: 600 },
  monitorCreate: { capacity: 20, refillSeconds: 3_600 },
  inviteSend: { capacity: 20, refillSeconds: 3_600 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof RATE_LIMIT_POLICIES;

function parseScriptResult(raw: unknown): [number, number, number] {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error("Unexpected rate limit script result");
  }
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

export interface ConsumeOptions {
  redis: RateLimitRedis;
  name: RateLimitName;
  /** Caller identity — an IP, a user id, an API key id, a heartbeat token. */
  subject: string;
  enabled?: boolean;
  cost?: number;
  keyPrefix?: string;
  /** Invoked when Redis fails and the limiter falls open, so the outage is observable. */
  onError?: (error: unknown) => void;
}

/**
 * Fails open when Redis is unreachable. Redis is already a hard dependency of
 * the check pipeline, so a Redis outage is a full product outage; refusing all
 * logins on top of that converts a degradation into a lockout.
 */
export async function consumeRateLimit(options: ConsumeOptions): Promise<RateLimitResult> {
  const policy = RATE_LIMIT_POLICIES[options.name];
  const cost = options.cost ?? 1;

  if (options.enabled === false) {
    return { allowed: true, remaining: policy.capacity, retryAfterSeconds: 0, policy };
  }

  const key = `${options.keyPrefix ?? "rl"}:${options.name}:${options.subject}`;
  const refillPerMs = policy.capacity / (policy.refillSeconds * 1_000);
  const ttlMs = Math.ceil(policy.refillSeconds * 1_000 * 2);

  try {
    const raw = await options.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      key,
      policy.capacity,
      refillPerMs,
      Date.now(),
      cost,
      ttlMs,
    );
    const [allowed, remaining, retryAfterMs] = parseScriptResult(raw);
    const isAllowed = allowed === 1;
    return {
      allowed: isAllowed,
      remaining,
      retryAfterSeconds: isAllowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      policy,
    };
  } catch (error) {
    options.onError?.(error);
    return { allowed: true, remaining: policy.capacity, retryAfterSeconds: 0, policy };
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.policy.capacity),
    "RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "RateLimit-Policy": `${result.policy.capacity};w=${result.policy.refillSeconds}`,
  };
  if (!result.allowed) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}
