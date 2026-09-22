import pino from "pino";

import { getProbeEnv } from "@sentinel/shared/env";

const env = getProbeEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "probe", region: env.REGION_CODE },
  timestamp: pino.stdTimeFunctions.isoTime,
});
