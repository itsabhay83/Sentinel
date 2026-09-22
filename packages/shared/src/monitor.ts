import { z } from "zod";
import { FAILURE_CODES, type FailureCode } from "./failure-codes";
import { REGION_CODES } from "./regions";

/** Aggregate state of a monitor after consensus. */
export const MONITOR_STATUSES = [
  "UP",
  "DEGRADED",
  "PARTIAL_OUTAGE",
  "DOWN",
  "PAUSED",
  "INCONCLUSIVE",
  "PENDING",
] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const MONITOR_TYPES = ["http", "tcp", "ping", "dns", "heartbeat", "flow"] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const INCIDENT_SEVERITIES = ["down", "partial", "degraded"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const ASSERTION_KINDS = ["keyword", "not_keyword", "jsonpath", "header", "response_time"] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const ASSERTION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "matches",
  "lt",
  "lte",
  "gt",
  "gte",
] as const;
export type AssertionOperator = (typeof ASSERTION_OPERATORS)[number];

export const ALERT_CHANNEL_KINDS = ["email", "slack", "discord", "webhook"] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

export const REGION_HEALTH_STATUSES = ["healthy", "degraded", "quarantined"] as const;
export type RegionHealthStatus = (typeof REGION_HEALTH_STATUSES)[number];

/** Allowed check intervals in seconds. */
export const CHECK_INTERVALS = [30, 60, 300, 900, 1800, 3600] as const;

// ---------------------------------------------------------------------------
// Wire contracts shared between scheduler, probe and web.
// ---------------------------------------------------------------------------

export const assertionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(ASSERTION_KINDS),
  /** JSONPath expression, header name, or empty for body keyword. */
  target: z.string().nullable(),
  operator: z.enum(ASSERTION_OPERATORS),
  value: z.string(),
  orderIndex: z.number().int(),
});
export type Assertion = z.infer<typeof assertionSchema>;

/** The complete, self-contained instruction a probe needs to run one check. */
export const checkJobSchema = z.object({
  jobId: z.string(),
  monitorId: z.string().uuid(),
  /** Groups all regional results belonging to one consensus round. */
  cycleId: z.string().uuid(),
  regionCode: z.enum(REGION_CODES),
  type: z.enum(MONITOR_TYPES),
  url: z.string(),
  method: z.string().default("GET"),
  /**
   * Request headers and body travel as AES-256-GCM ciphertext and are decrypted
   * inside the probe, immediately before the socket opens. They routinely carry
   * bearer tokens, and BullMQ persists every job to Redis' append-only file --
   * shipping them in plaintext would undo the at-rest encryption the database
   * already applies.
   */
  headersEncrypted: z.string().nullable().default(null),
  bodyEncrypted: z.string().nullable().default(null),
  flowStepsEncrypted: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive(),
  followRedirects: z.boolean(),
  maxRedirects: z.number().int().nonnegative(),
  expectedStatusCodes: z.array(z.number().int()),
  assertions: z.array(assertionSchema).default([]),
  scheduledAt: z.number().int(),
});
export type CheckJob = z.infer<typeof checkJobSchema>;

/** Per-phase timing breakdown, milliseconds. Null when the phase never ran. */
export const timingSchema = z.object({
  dnsMs: z.number().nullable(),
  tcpMs: z.number().nullable(),
  tlsMs: z.number().nullable(),
  ttfbMs: z.number().nullable(),
  transferMs: z.number().nullable(),
  totalMs: z.number(),
});
export type Timing = z.infer<typeof timingSchema>;

export const checkResultSchema = z.object({
  jobId: z.string(),
  monitorId: z.string().uuid(),
  cycleId: z.string().uuid(),
  regionCode: z.enum(REGION_CODES),
  checkedAt: z.number().int(),
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  errorDetail: z.string().nullable(),
  timing: timingSchema,
  responseSizeBytes: z.number().int().nullable(),
  resolvedIp: z.string().nullable(),
  certExpiresAt: z.number().int().nullable(),
  /** Bounded prefix of the body, captured only on failure for the incident UI. */
  bodySnippet: z.string().nullable(),
  responseHeaders: z.record(z.string()).nullable(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isFailure(result: Pick<CheckResult, "ok">): boolean {
  return !result.ok;
}

export function statusColor(status: MonitorStatus): string {
  switch (status) {
    case "UP":
      return "#10b981";
    case "DEGRADED":
      return "#f59e0b";
    case "PARTIAL_OUTAGE":
      return "#f97316";
    case "DOWN":
      return "#ef4444";
    case "PAUSED":
      return "#64748b";
    case "INCONCLUSIVE":
      return "#8b5cf6";
    case "PENDING":
      return "#64748b";
  }
}

export function statusLabel(status: MonitorStatus): string {
  switch (status) {
    case "UP":
      return "Operational";
    case "DEGRADED":
      return "Degraded";
    case "PARTIAL_OUTAGE":
      return "Partial outage";
    case "DOWN":
      return "Down";
    case "PAUSED":
      return "Paused";
    case "INCONCLUSIVE":
      return "Inconclusive";
    case "PENDING":
      return "Pending";
  }
}

export function severityForStatus(status: MonitorStatus): IncidentSeverity | null {
  switch (status) {
    case "DOWN":
      return "down";
    case "PARTIAL_OUTAGE":
      return "partial";
    case "DEGRADED":
      return "degraded";
    default:
      return null;
  }
}

export type { FailureCode };
