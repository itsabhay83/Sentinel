import { Queue } from "bullmq";
import type IORedis from "ioredis";

import { withDbRetry } from "@sentinel/db";
import { checkQueueName, isRegionCode, type CheckJob, type RegionCode } from "@sentinel/shared";
import { encryptJson } from "@sentinel/shared/server";
import { getServerEnv } from "@sentinel/shared/env";

import { claimDueMonitors, resolveFlowSteps, type ClaimedMonitor } from "./claim";
import { logger } from "./logger";
import {
  dispatchBackpressure,
  dispatchJobsEnqueued,
  dispatchMonitorsClaimed,
  queueDepth,
} from "./metrics";

export class Dispatcher {
  private readonly queues = new Map<RegionCode, Queue>();

  constructor(private readonly connection: IORedis) {}

  private queueFor(region: RegionCode): Queue {
    let queue = this.queues.get(region);
    if (!queue) {
      queue = new Queue(checkQueueName(region), { connection: this.connection });
      this.queues.set(region, queue);
    }
    return queue;
  }

  /** Waiting plus delayed. Active jobs are already owned by a probe. */
  private async depthOf(region: RegionCode): Promise<number> {
    const counts = await this.queueFor(region).getJobCounts("waiting", "delayed");
    return (counts["waiting"] ?? 0) + (counts["delayed"] ?? 0);
  }

  private buildJobs(monitor: ClaimedMonitor, now: Date, key: string): Map<RegionCode, CheckJob> {
    const regions = (monitor.regions ?? []).filter(isRegionCode);
    const flowStepsEncrypted =
      monitor.flow_steps && monitor.flow_steps.length > 0
        ? encryptJson(resolveFlowSteps(monitor.flow_steps, key), key)
        : null;

    return new Map(
      regions.map((region) => [
        region,
        {
          // Underscore, not colon: BullMQ composes its own Redis keys from the
          // job id and rejects a colon at construction time.
          jobId: `${monitor.cycle_id}_${region}`,
          monitorId: monitor.monitor_id,
          cycleId: monitor.cycle_id,
          regionCode: region,
          type: monitor.type,
          url: monitor.url,
          method: monitor.method,
          headersEncrypted: monitor.headers_encrypted,
          bodyEncrypted: monitor.body_encrypted,
          flowStepsEncrypted,
          timeoutMs: monitor.timeout_ms,
          followRedirects: monitor.follow_redirects,
          maxRedirects: monitor.max_redirects,
          expectedStatusCodes: monitor.expected_status_codes ?? [],
          assertions: monitor.assertions ?? [],
          scheduledAt: now.getTime(),
        } satisfies CheckJob,
      ]),
    );
  }

  /**
   * Enqueues one region's batch unless the queue is already past
   * `QUEUE_MAX_DEPTH`.
   *
   * Dropping a tick is the correct trade: the monitor's `next_run_at` has
   * already advanced, so the next cycle dispatches normally, whereas letting an
   * unconsumed queue grow turns a stalled probe into a Redis outage.
   */
  private async enqueueRegion(region: RegionCode, jobs: CheckJob[]): Promise<number> {
    const env = getServerEnv();
    const depth = await this.depthOf(region);
    queueDepth.set({ region }, depth);

    if (depth > env.QUEUE_MAX_DEPTH) {
      dispatchBackpressure.inc({ region });
      logger.warn(
        { region, depth, maxDepth: env.QUEUE_MAX_DEPTH, skipped: jobs.length },
        "region queue over QUEUE_MAX_DEPTH; skipping enqueue this tick",
      );
      return 0;
    }

    await this.queueFor(region).addBulk(
      jobs.map((job) => ({
        name: "check",
        data: job,
        opts: {
          jobId: job.jobId,
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400, count: 5_000 },
          attempts: env.CHECK_JOB_ATTEMPTS,
          backoff: { type: "exponential", delay: 2_000 },
        },
      })),
    );

    dispatchJobsEnqueued.inc({ region }, jobs.length);
    return jobs.length;
  }

  async dispatchDue(now = new Date()): Promise<number> {
    const claimed = await withDbRetry(() => claimDueMonitors(now), "claim due monitors");
    if (claimed.length === 0) return 0;
    dispatchMonitorsClaimed.inc(claimed.length);

    const key = getServerEnv().ENCRYPTION_KEY;
    const byRegion = new Map<RegionCode, CheckJob[]>();
    let skipped = 0;

    for (const monitor of claimed) {
      const jobs = this.buildJobs(monitor, now, key);
      if (jobs.size === 0) {
        skipped += 1;
        logger.warn(
          { cycleId: monitor.cycle_id, monitorId: monitor.monitor_id },
          "monitor has no enabled regions",
        );
        continue;
      }
      for (const [region, job] of jobs) {
        const bucket = byRegion.get(region) ?? [];
        bucket.push(job);
        byRegion.set(region, bucket);
      }
      logger.debug(
        {
          cycleId: monitor.cycle_id,
          monitorId: monitor.monitor_id,
          type: monitor.type,
          regions: [...jobs.keys()],
        },
        "check cycle dispatched",
      );
    }

    const enqueued = await Promise.all(
      [...byRegion.entries()].map(([region, jobs]) => this.enqueueRegion(region, jobs)),
    );
    const dispatched = enqueued.reduce((total, count) => total + count, 0);

    logger.debug({ monitors: claimed.length, jobs: dispatched, skipped }, "dispatch tick complete");
    return dispatched;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
