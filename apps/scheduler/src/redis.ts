import IORedis from "ioredis";

import { getServerEnv } from "@sentinel/shared/env";

export function createRedis(): IORedis {
  return new IORedis(getServerEnv().REDIS_URL, {
    // BullMQ blocks on BRPOPLPUSH; a retry ceiling would kill an idle consumer.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
