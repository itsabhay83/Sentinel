/**
 * 30s → 2m → 8m → 30m → 2h. The ladder is roughly quadrupling, and stops
 * widening at two hours because a page that has failed for two hours is an
 * operator problem, not a transport blip.
 */
const RETRY_LADDER_SECONDS = [30, 120, 480, 1_800, 7_200] as const;

/**
 * Delay before attempt `attempt` (1-based) is retried, with ±20% jitter so a
 * transport outage that fails every channel at once does not bring them all
 * back in lockstep.
 */
export function retryDelaySeconds(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_LADDER_SECONDS.length) - 1;
  const base = RETRY_LADDER_SECONDS[index] ?? RETRY_LADDER_SECONDS[0];
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function retryAt(attempt: number, from = new Date()): Date {
  return new Date(from.getTime() + retryDelaySeconds(attempt) * 1_000);
}

