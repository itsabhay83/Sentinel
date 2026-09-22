import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import { getServerEnv } from "@sentinel/shared/env";

/**
 * Every label used here is drawn from a closed set — region codes, tick phases,
 * delivery statuses, incident severities. Monitor ids, URLs and organisation ids
 * are deliberately absent: each distinct label value is a separate time series,
 * and an unbounded label turns Prometheus into a memory leak.
 */
export const registry = new Registry();

if (getServerEnv().METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry });
}

export const dispatchMonitorsClaimed = new Counter({
  name: "sentinel_dispatch_monitors_claimed_total",
  help: "Monitors claimed from monitor_state for dispatch",
  registers: [registry],
});

export const dispatchJobsEnqueued = new Counter({
  name: "sentinel_dispatch_jobs_enqueued_total",
  help: "Check jobs enqueued onto a regional queue",
  labelNames: ["region"] as const,
  registers: [registry],
});

export const dispatchBackpressure = new Counter({
  name: "sentinel_dispatch_backpressure_total",
  help: "Enqueues skipped because a regional queue was over QUEUE_MAX_DEPTH",
  labelNames: ["region"] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: "sentinel_queue_depth",
  help: "Waiting plus delayed jobs on a regional queue",
  labelNames: ["region"] as const,
  registers: [registry],
});

export const tickDuration = new Histogram({
  name: "sentinel_tick_duration_seconds",
  help: "Wall time of one scheduler tick phase",
  labelNames: ["phase"] as const,
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const leaderGauge = new Gauge({
  name: "sentinel_leader",
  help: "1 while this instance holds a verified scheduler leader lock, 0 otherwise",
  registers: [registry],
});

export const fencingToken = new Gauge({
  name: "sentinel_leader_fencing_token",
  help: "Fencing token this instance was elected with; 0 when not leader",
  registers: [registry],
});

export const incidentsOpened = new Counter({
  name: "sentinel_incidents_opened_total",
  help: "Incidents opened, by severity",
  labelNames: ["severity"] as const,
  registers: [registry],
});

export const alertDeliveries = new Counter({
  name: "sentinel_alert_deliveries_total",
  help: "Alert delivery attempts, by resulting status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const alertDeliveriesDead = new Counter({
  name: "sentinel_alert_deliveries_dead_total",
  help: "Alert deliveries that exhausted their retry budget and will never be sent",
  registers: [registry],
});

export const alertsSuppressed = new Counter({
  name: "sentinel_alerts_suppressed_total",
  help: "Alert enqueues skipped because the monitor was inside a maintenance window",
  registers: [registry],
});

export const partitionGaps = new Gauge({
  name: "sentinel_partition_gaps",
  help: "Instants in the required coverage window with no matching checks partition",
  registers: [registry],
});

export const partitionBoundsUnparseable = new Counter({
  name: "sentinel_partition_bounds_unparseable_total",
  help: "Partitions whose range bound could not be parsed during retention maintenance",
  registers: [registry],
});

/** Records the phase duration whether the phase succeeded or threw. */
export async function timePhase<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const stop = tickDuration.startTimer({ phase });
  try {
    return await run();
  } finally {
    stop();
  }
}
