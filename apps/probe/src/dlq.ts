import type { Job } from "bullmq";

import { checkJobFailures, db, withDbRetry } from "@sentinel/db";
import { checkJobSchema, type CheckJob } from "@sentinel/shared";

import { logger } from "./logger";
import { deadLettered } from "./metrics";
import { captureError } from "./sentry";

const REDACTED = "[redacted]";

/**
 * The dead-letter row exists so a fixed job can be replayed, which means it is
 * read by humans and by support tooling — neither of which should ever see a
 * customer's bearer token. The encrypted envelopes are replaced rather than
 * copied, and assertions are reduced to a count because their `value` is
 * frequently the secret being matched against.
 */
function redact(job: CheckJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    monitorId: job.monitorId,
    cycleId: job.cycleId,
    regionCode: job.regionCode,
    type: job.type,
    url: job.url,
    method: job.method,
    headersEncrypted: job.headersEncrypted === null ? null : REDACTED,
    bodyEncrypted: job.bodyEncrypted === null ? null : REDACTED,
    flowStepsEncrypted: job.flowStepsEncrypted === null ? null : REDACTED,
    timeoutMs: job.timeoutMs,
    followRedirects: job.followRedirects,
    maxRedirects: job.maxRedirects,
    expectedStatusCodes: job.expectedStatusCodes,
    assertionCount: job.assertions.length,
    scheduledAt: job.scheduledAt,
  };
}

/** True once BullMQ has spent the job's whole retry budget. */
export function isFinalFailure(job: Job<unknown>): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

export async function deadLetter(job: Job<unknown>, error: Error): Promise<void> {
  const parsed = checkJobSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.error(
      { jobId: job.id, issues: parsed.error.issues },
      "cannot dead-letter a malformed check job",
    );
    return;
  }

  const checkJob = parsed.data;
  try {
    await withDbRetry(
      () =>
        db.insert(checkJobFailures).values({
          monitorId: checkJob.monitorId,
          regionCode: checkJob.regionCode,
          payload: redact(checkJob),
          error: error.message.slice(0, 2_000),
          attempts: job.attemptsMade,
        }),
      "insert check job failure",
    );
    deadLettered.inc({ region: checkJob.regionCode });
    logger.error(
      {
        cycleId: checkJob.cycleId,
        monitorId: checkJob.monitorId,
        jobId: job.id,
        attempts: job.attemptsMade,
        err: error.message,
      },
      "check job dead-lettered",
    );
  } catch (writeError) {
    captureError(writeError, { jobId: job.id, monitorId: checkJob.monitorId });
    logger.error(
      { cycleId: checkJob.cycleId, jobId: job.id, err: writeError },
      "failed to record check job in the dead letter table",
    );
  }
}
