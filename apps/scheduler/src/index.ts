import { closeDb } from "@sentinel/db";
import { getServerEnv } from "@sentinel/shared/env";

import {
  deliverPendingAlerts,
  escalateOpenIncidents,
  notifyStatusPageSubscribers,
} from "./alerting/index";
import { Dispatcher } from "./dispatch";
import { evaluatePendingCycles } from "./evaluate";
import type { LeaderFence } from "./fencing";
import { startHealthServer } from "./health";
import {
  checkCertificateExpiry,
  checkHeartbeats,
  detectFlapping,
  enforceRawRetention,
  maintainPartitions,
  refreshLatencyBaselines,
  rollup1h,
  rollup5m,
  updateRegionQuarantine,
} from "./housekeeping/index";
import { INSTANCE_ID, LeaderElection } from "./leader";
import { logger } from "./logger";
import { fencingToken, leaderGauge, timePhase } from "./metrics";
import { createRedis } from "./redis";
import { captureError, initSentry } from "./sentry";
import { installShutdownHandlers } from "./shutdown";

const TICK_MS = 1_000;
/** Compose gives the scheduler 20s; exiting under our own control at 15s leaves
 * room to flush logs instead of being SIGKILLed mid-write. */
const SHUTDOWN_GRACE_MS = 15_000;
/** The in-flight tick gets most of the budget; connection teardown gets the rest. */
const TICK_DRAIN_MS = 10_000;

/**
 * Interval-driven work, in seconds.
 *
 * Dispatch and evaluation run on every instance - both are safe under
 * concurrency because they claim rows with SKIP LOCKED. Everything gated on a
 * fence mutates shared aggregates or DDL and runs on the leader only.
 */
const EVERY = {
  evaluate: 2,
  deliverAlerts: 3,
  escalate: 30,
  notifySubscribers: 15,
  rollup5m: 60,
  heartbeats: 30,
  quarantine: 60,
  flapping: 120,
  rollup1h: 300,
  baselines: 900,
  certs: 3_600,
  retention: 3_600,
  partitions: 3_600,
} as const;

type TaskName = keyof typeof EVERY;

const lastRunAt = new Map<TaskName, number>();

/**
 * Runs `fn` if its interval has elapsed. Failures are logged and swallowed so
 * one broken maintenance query cannot take the dispatch loop down with it.
 */
async function maybeRun(name: TaskName, now: number, fn: () => Promise<unknown>): Promise<void> {
  const dueAt = (lastRunAt.get(name) ?? 0) + EVERY[name] * 1_000;
  if (now < dueAt) return;
  lastRunAt.set(name, now);
  try {
    const result = await fn();
    if (typeof result === "number" && result > 0) {
      logger.info({ task: name, result }, "housekeeping task completed");
    }
  } catch (error) {
    captureError(error, { task: name });
    logger.error({ task: name, err: error }, "housekeeping task failed");
  }
}

async function runLeaderTasks(fence: LeaderFence, at: number): Promise<void> {
  await maybeRun("escalate", at, () => escalateOpenIncidents(fence));
  await maybeRun("notifySubscribers", at, () => notifyStatusPageSubscribers(fence));
  await maybeRun("heartbeats", at, () => checkHeartbeats(fence));
  await maybeRun("rollup5m", at, () => rollup5m(fence));
  await maybeRun("quarantine", at, () => updateRegionQuarantine(fence));
  await maybeRun("flapping", at, () => detectFlapping(fence));
  await maybeRun("rollup1h", at, () => rollup1h(fence));
  await maybeRun("baselines", at, () => refreshLatencyBaselines(fence));
  await maybeRun("certs", at, () => checkCertificateExpiry(fence));
  await maybeRun("retention", at, () => enforceRawRetention(fence));
  await maybeRun("partitions", at, () => maintainPartitions(fence));
}

async function main(): Promise<void> {
  const env = getServerEnv();
  await initSentry();

  const redis = createRedis();
  const dispatcher = new Dispatcher(redis);
  const leader = new LeaderElection();

  let running = true;
  let ticks = 0;
  let inFlightTick: Promise<void> | null = null;

  const health = startHealthServer({
    port: env.SCHEDULER_HEALTH_PORT,
    redis,
    isLeader: () => leader.isLeader,
  });

  const runTick = async (now: Date): Promise<void> => {
    const at = now.getTime();

    await timePhase("dispatch", async () => {
      try {
        const dispatched = await dispatcher.dispatchDue(now);
        if (dispatched > 0) logger.debug({ dispatched }, "dispatched checks");
      } catch (error) {
        captureError(error, { phase: "dispatch" });
        logger.error({ err: error }, "dispatch failed");
      }
    });

    await maybeRun("evaluate", at, () => timePhase("evaluate", () => evaluatePendingCycles(now)));
    await maybeRun("deliverAlerts", at, () => timePhase("alert", () => deliverPendingAlerts()));

    // Re-proven every tick: whoever still owns the advisory lock keeps its
    // fence, and a replacement takes over within a second of the leader dying.
    const fence = await leader.tryAcquire();
    leaderGauge.set(fence === null ? 0 : 1);
    fencingToken.set(fence?.token ?? 0);
    if (fence === null) return;

    await timePhase("housekeeping", () => runLeaderTasks(fence, at));
  };

  installShutdownHandlers({
    graceMs: SHUTDOWN_GRACE_MS,
    drain: async () => {
      running = false;
      if (inFlightTick !== null) {
        await Promise.race([
          inFlightTick,
          new Promise<void>((resolve) => {
            setTimeout(resolve, TICK_DRAIN_MS).unref();
          }),
        ]);
      }
      await dispatcher.close();
      await leader.release();
      await redis.quit().catch(() => undefined);
      await closeDb();
      health.close();
    },
  });

  logger.info(
    { port: env.SCHEDULER_HEALTH_PORT, instanceId: INSTANCE_ID },
    "scheduler started",
  );

  while (running) {
    const startedAt = Date.now();
    ticks += 1;

    inFlightTick = runTick(new Date(startedAt));
    await inFlightTick;
    inFlightTick = null;

    if (ticks % 60 === 0) {
      logger.info({ ticks, leader: leader.isLeader }, "scheduler heartbeat");
    }

    const elapsed = Date.now() - startedAt;
    if (running && elapsed < TICK_MS) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS - elapsed));
    }
  }
}

main().catch((error: unknown) => {
  captureError(error, { phase: "boot" });
  logger.fatal({ err: error }, "scheduler crashed");
  process.exit(1);
});
