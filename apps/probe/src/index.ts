import { Queue, Worker, type Job } from "bullmq";

import type { CheckOutcome, FlowStep } from "@sentinel/checker";
import { closeDb, db, checks, withDbRetry } from "@sentinel/db";
import {
  REGION_CODES,
  RESULTS_QUEUE,
  checkJobSchema,
  checkQueueName,
  isRegionCode,
  type CheckJob,
  type CheckResult,
  type RegionCode,
} from "@sentinel/shared";
import { decryptJson } from "@sentinel/shared/server";
import { getProbeEnv } from "@sentinel/shared/env";

import { deadLetter, isFinalFailure } from "./dlq";
import { startHealthServer } from "./health";
import { logger } from "./logger";
import {
  checkDuration,
  checkFailures,
  checksTotal,
  queueJobsActive,
  queueLatency,
} from "./metrics";
import { createRedis } from "./redis";
import { runCheck, type ResolvedCheckJob } from "./run-check";
import { captureError, initSentry } from "./sentry";
import { installShutdownHandlers } from "./shutdown";

/** Compose gives the probe 30s; exiting under our own control at 25s leaves
 * room to flush logs instead of being SIGKILLed mid-write. */
const SHUTDOWN_GRACE_MS = 25_000;

const env = getProbeEnv();
const configuredRegion = env.REGION_CODE;
if (!isRegionCode(configuredRegion)) {
  throw new Error(
    `REGION_CODE "${configuredRegion}" is not a known region. Valid codes: ${REGION_CODES.join(", ")}`,
  );
}
// Re-bound so the narrowed type survives into the worker closures below.
const region: RegionCode = configuredRegion;

await initSentry();

const connection = createRedis();
const resultsQueue = new Queue(RESULTS_QUEUE, { connection });

function resolveJob(raw: CheckJob): ResolvedCheckJob {
  return {
    ...raw,
    headers: decryptJson<Record<string, string>>(raw.headersEncrypted, env.ENCRYPTION_KEY, {}),
    body: raw.bodyEncrypted
      ? decryptJson<{ value: string }>(raw.bodyEncrypted, env.ENCRYPTION_KEY, { value: "" }).value
      : null,
    flowSteps: decryptJson<FlowStep[]>(raw.flowStepsEncrypted, env.ENCRYPTION_KEY, []),
  };
}

async function record(job: CheckJob, checkedAt: Date, outcome: CheckOutcome): Promise<void> {
  await withDbRetry(
    () =>
      db.insert(checks).values({
        monitorId: job.monitorId,
        regionCode: region,
        cycleId: job.cycleId,
        checkedAt,
        ok: outcome.ok,
        statusCode: outcome.statusCode,
        failureCode: outcome.failureCode,
        errorDetail: outcome.errorDetail,
        dnsMs: outcome.timing.dnsMs,
        tcpMs: outcome.timing.tcpMs,
        tlsMs: outcome.timing.tlsMs,
        ttfbMs: outcome.timing.ttfbMs,
        transferMs: outcome.timing.transferMs,
        totalMs: outcome.timing.totalMs,
        responseSizeBytes: outcome.responseSizeBytes,
        resolvedIp: outcome.resolvedIp,
        certExpiresAt: outcome.certExpiresAt,
        bodySnippet: outcome.bodySnippet,
        responseHeaders: outcome.responseHeaders,
      }),
    "insert check",
  );

  const result: CheckResult = {
    jobId: job.jobId,
    monitorId: job.monitorId,
    cycleId: job.cycleId,
    regionCode: region,
    checkedAt: checkedAt.getTime(),
    ok: outcome.ok,
    statusCode: outcome.statusCode,
    failureCode: outcome.failureCode,
    errorDetail: outcome.errorDetail,
    timing: outcome.timing,
    responseSizeBytes: outcome.responseSizeBytes,
    resolvedIp: outcome.resolvedIp,
    certExpiresAt: outcome.certExpiresAt?.getTime() ?? null,
    bodySnippet: outcome.bodySnippet,
    responseHeaders: outcome.responseHeaders,
  };

  await resultsQueue.add("result", result, { removeOnComplete: true, removeOnFail: 500 });
}

async function handle(job: Job<unknown>): Promise<void> {
  const parsed = checkJobSchema.safeParse(job.data);
  if (!parsed.success) {
    checksTotal.inc({ region, type: "unknown", result: "malformed" });
    logger.error(
      { jobId: job.id, issues: parsed.error.issues },
      "discarding malformed check job",
    );
    return;
  }

  const checkJob = parsed.data;
  queueJobsActive.inc();
  queueLatency.observe({ region }, Math.max(0, Date.now() - checkJob.scheduledAt) / 1_000);
  const stopTimer = checkDuration.startTimer({ region, type: checkJob.type });

  try {
    const checkedAt = new Date();
    const outcome = await runCheck(resolveJob(checkJob));
    await record(checkJob, checkedAt, outcome);

    checksTotal.inc({ region, type: checkJob.type, result: outcome.ok ? "ok" : "failed" });
    if (!outcome.ok) {
      checkFailures.inc({ region, failure_code: outcome.failureCode ?? "UNKNOWN" });
    }

    logger.debug(
      {
        cycleId: checkJob.cycleId,
        monitorId: checkJob.monitorId,
        jobId: checkJob.jobId,
        ok: outcome.ok,
        failureCode: outcome.failureCode,
        totalMs: outcome.timing.totalMs,
      },
      "check complete",
    );
  } finally {
    stopTimer();
    queueJobsActive.dec();
  }
}

const worker = new Worker(checkQueueName(region), handle, {
  connection,
  concurrency: env.PROBE_CONCURRENCY,
  // A check that outlives its lock would be re-delivered and double-counted in
  // consensus, so the lock must outlast the longest permitted request. The
  // stalled sweep is stated rather than inherited, and one redelivery is all a
  // check deserves: by the time a second one lands the cycle has moved on.
  lockDuration: 90_000,
  stalledInterval: 60_000,
  maxStalledCount: 1,
});

worker.on("failed", (job, error) => {
  if (!job) {
    logger.error({ err: error.message }, "check job failed with no job reference");
    return;
  }
  logger.error(
    { jobId: job.id, attempts: job.attemptsMade, err: error.message },
    "check job failed",
  );
  if (isFinalFailure(job)) void deadLetter(job, error);
});

worker.on("error", (error) => {
  captureError(error, { phase: "worker" });
  logger.error({ err: error }, "worker error");
});

const health =
  env.PROBE_HEALTH_PORT > 0
    ? startHealthServer({
        port: env.PROBE_HEALTH_PORT,
        region,
        redis: connection,
        isWorkerRunning: () => worker.isRunning(),
      })
    : null;

installShutdownHandlers({
  graceMs: SHUTDOWN_GRACE_MS,
  drain: async () => {
    // `close()` without force lets in-flight checks finish and release their
    // locks, so a redeploy does not hand half a cycle to the next worker.
    await worker.close();
    await resultsQueue.close();
    await connection.quit().catch(() => undefined);
    await closeDb();
    health?.close();
  },
});

logger.info(
  {
    concurrency: env.PROBE_CONCURRENCY,
    queue: checkQueueName(region),
    healthPort: env.PROBE_HEALTH_PORT,
  },
  "probe worker started",
);
