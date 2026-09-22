import { getServerEnv } from "@sentinel/shared/env";

/**
 * Postgres error classes worth retrying: class 08 (connection exception),
 * 40001 serialization_failure, 40P01 deadlock_detected, 57P01 admin_shutdown,
 * 57P03 cannot_connect_now, 55P03 lock_not_available. Anything else — a
 * constraint violation, a syntax error, a statement timeout — is deterministic
 * and retrying it only multiplies the damage.
 */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "53300", "55P03", "57P01", "57P03"]);

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return code.startsWith("08") || RETRYABLE_SQLSTATES.has(code);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Retries only transient failures, with full jitter so a Postgres failover does
 * not produce a synchronised thundering herd from every probe and scheduler.
 */
export async function withDbRetry<T>(operation: () => Promise<T>, label = "query"): Promise<T> {
  const maxRetries = getServerEnv().DB_MAX_RETRIES;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts = attempt + 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Deterministic failures (constraint violations, syntax errors) are rethrown
      // untouched so callers keep the SQLSTATE they branch on.
      if (!isRetryable(error)) throw error;
      if (attempt === maxRetries) break;
      await sleep(Math.random() * Math.min(2_000, 100 * 2 ** attempt));
    }
  }
  throw new Error(`Database ${label} failed after ${attempts} attempt(s)`, { cause: lastError });
}
