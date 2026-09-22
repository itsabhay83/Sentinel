import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import { getProbeEnv } from "@sentinel/shared/env";

/**
 * Labels are drawn from closed sets only: eight region codes, six monitor
 * types, the failure taxonomy. Monitor ids and target URLs are unbounded and
 * would make every monitor a separate time series, so they stay in the logs.
 */
export const registry = new Registry();

if (getProbeEnv().METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry });
}

export const checksTotal = new Counter({
  name: "sentinel_checks_total",
  help: "Checks executed, by outcome",
  labelNames: ["region", "type", "result"] as const,
  registers: [registry],
});

export const checkDuration = new Histogram({
  name: "sentinel_check_duration_seconds",
  help: "Wall time of one executed check",
  labelNames: ["region", "type"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const checkFailures = new Counter({
  name: "sentinel_check_failures_total",
  help: "Failed checks, by failure taxonomy code",
  labelNames: ["region", "failure_code"] as const,
  registers: [registry],
});

export const queueJobsActive = new Gauge({
  name: "sentinel_queue_jobs_active",
  help: "Check jobs currently executing in this probe",
  registers: [registry],
});

/**
 * Time a job spent waiting between dispatch and execution. A cycle whose
 * results land after the evaluator's grace window is silently excluded from
 * consensus, so this is the metric that explains a monitor reporting
 * INCONCLUSIVE while every probe looks healthy.
 */
export const queueLatency = new Histogram({
  name: "sentinel_check_queue_latency_seconds",
  help: "Delay between a check being dispatched and the probe starting it",
  labelNames: ["region"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 30, 60, 300],
  registers: [registry],
});

export const deadLettered = new Counter({
  name: "sentinel_check_jobs_dead_lettered_total",
  help: "Check jobs that exhausted their retries and were written to check_job_failures",
  labelNames: ["region"] as const,
  registers: [registry],
});
