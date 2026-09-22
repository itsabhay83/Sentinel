import IORedis from "ioredis";

import { getProbeEnv } from "@sentinel/shared/env";

export function createRedis(): IORedis {
  const env = getProbeEnv();
  return new IORedis(env.REDIS_URL, {
    // BullMQ blocks on BRPOPLPUSH; a retry ceiling would kill an idle worker.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
