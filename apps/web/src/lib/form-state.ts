import type { RateLimitResult } from "@/lib/ratelimit";

/**
 * Rate limiting is an ordinary user outcome on a login form, not an exception,
 * so it is reported in the same `{ error }` shape every other refusal uses
 * rather than thrown as a 429 the way the REST API reports it.
 */
export function rateLimited(result: RateLimitResult): { error: string } {
  return { error: `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.` };
}
