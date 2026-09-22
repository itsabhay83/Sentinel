import "server-only";

import { getServerEnv } from "@sentinel/shared/env";
import IORedis from "ioredis";

/**
 * Cached on globalThis for the same reason the Postgres pool is: Next.js dev
 * HMR re-evaluates modules on every edit, and a fresh ioredis client per
 * evaluation leaks connections until Redis refuses new ones.
 */
type RedisGlobal = typeof globalThis & { __sentinelWebRedis?: IORedis };

const globalRef = globalThis as RedisGlobal;

function createRedis(): IORedis {
  return new IORedis(getServerEnv().REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
}

export const redis: IORedis = globalRef.__sentinelWebRedis ?? createRedis();

if (process.env.NODE_ENV !== "production") {
  globalRef.__sentinelWebRedis = redis;
}
