import pino from "pino";

import { getServerEnv } from "@sentinel/shared/env";

export const logger = pino({
  level: getServerEnv().LOG_LEVEL,
  base: { service: "scheduler" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
