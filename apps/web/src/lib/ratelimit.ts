import "server-only";

import { headers } from "next/headers";

import { getServerEnv } from "@sentinel/shared/env";
import {
  consumeRateLimit,
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
  type RateLimitName,
  type RateLimitResult,
} from "@sentinel/shared/ratelimit";

import { redis } from "./redis";

export { rateLimitHeaders };
export type { RateLimitResult };

/**
 * Trusts only the FIRST hop in `x-forwarded-for`, which is the value the edge
 * proxy prepends. Later entries are attacker-controlled: a client can send its
 * own `X-Forwarded-For` header and would otherwise be able to forge a fresh
 * rate-limit identity on every request.
 */
export async function callerIp(): Promise<string> {
  const hdrs = await headers();
  const forwarded = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return hdrs.get("x-real-ip")?.trim() ?? "unknown";
}

export async function checkRateLimit(name: RateLimitName, subject: string): Promise<RateLimitResult> {
  return consumeRateLimit({
    redis,
    name,
    subject,
    enabled: getServerEnv().RATE_LIMIT_ENABLED,
  });
}

/** Limits by client IP — for endpoints reached before any identity is known. */
export async function checkIpRateLimit(name: RateLimitName): Promise<RateLimitResult> {
  return checkRateLimit(name, await callerIp());
}

/**
 * Credential endpoints are limited on BOTH the IP and the submitted identifier.
 * IP alone lets a botnet spread one attack across thousands of addresses;
 * identifier alone lets one host enumerate thousands of accounts.
 */
export async function checkCredentialRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const ip = await callerIp();
  const byIp = await checkRateLimit(name, `ip:${ip}`);
  if (!byIp.allowed) return byIp;
  return checkRateLimit(name, `id:${identifier.toLowerCase()}`);
}

/**
 * Enforces a per-plan allowance on top of a shared policy.
 *
 * `consumeRateLimit` reads its capacity from the shared policy table, which has
 * no notion of plans. Scaling the token cost by `capacity / allowance` drains
 * that same bucket at exactly the allowance's rate, so the plan limit is what
 * actually binds whenever the two disagree — without forking the shared policy.
 */
export async function checkPlanRateLimit(
  name: RateLimitName,
  subject: string,
  allowancePerWindow: number,
): Promise<RateLimitResult> {
  const policy = RATE_LIMIT_POLICIES[name];
  const allowance = Math.max(1, allowancePerWindow);
  const cost = policy.capacity / allowance;
  const result = await consumeRateLimit({
    redis,
    name,
    subject,
    cost,
    enabled: getServerEnv().RATE_LIMIT_ENABLED,
  });
  return {
    ...result,
    remaining: Math.floor(result.remaining / cost),
    policy: { capacity: allowance, refillSeconds: policy.refillSeconds },
  };
}

export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: "rate_limited", message: "Too many requests. Please retry later." },
    { status: 429, headers: rateLimitHeaders(result) },
  );
}

/** Server actions surface refusals as form state, so they need copy rather than a 429. */
export function retryAfterMessage(result: RateLimitResult): string {
  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  if (minutes <= 1) return "Too many requests. Try again in a minute.";
  return `Too many requests. Try again in ${minutes} minutes.`;
}
