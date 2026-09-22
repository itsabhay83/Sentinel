import "server-only";

import { sql } from "@sentinel/db";
import { redis } from "@/lib/redis";

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 2_000;

export interface DependencyHealth {
  readonly ok: boolean;
  readonly database: boolean;
  readonly redis: boolean;
  readonly checkedAt: string;
}

interface CacheEntry {
  readonly result: DependencyHealth;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<DependencyHealth> | null = null;

async function withTimeout(probe: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health probe timed out")), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDependencies(): Promise<DependencyHealth> {
  const [database, cacheOk] = await Promise.all([
    withTimeout(() => sql`select 1`),
    withTimeout(() => redis.ping()),
  ]);
  return {
    ok: database && cacheOk,
    database,
    redis: cacheOk,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Cached with in-flight de-duplication so an external prober (or a load
 * balancer with an aggressive interval) cannot turn the readiness endpoint into
 * an unauthenticated amplification path against Postgres and Redis.
 */
export async function checkDependencies(): Promise<DependencyHealth> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.result;
  if (inFlight) return inFlight;

  inFlight = probeDependencies()
    .then((result) => {
      cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
