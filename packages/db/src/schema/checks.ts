import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { monitors } from "./monitors";

/**
 * Raw check results — the high-volume time series.
 *
 * This table is `PARTITION BY RANGE (checked_at)` in Postgres. Drizzle cannot
 * express declarative partitioning, so migration `0001_partition_checks.sql`
 * rebuilds it as a partitioned parent and `src/partitions.ts` maintains the
 * monthly children. The composite primary key includes `checked_at` because
 * Postgres requires the partition key in every unique constraint.
 *
 * Retention: raw rows 30d (paid) / 7d (free); rollups 13 months.
 */
export const checks = pgTable(
  "checks",
  {
    id: uuid("id").notNull().defaultRandom(),
    monitorId: uuid("monitor_id").notNull(),
    regionCode: text("region_code").notNull(),
    /** Groups every region's result for one consensus round. */
    cycleId: uuid("cycle_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),

    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    failureCode: text("failure_code"),
    errorDetail: text("error_detail"),

    dnsMs: doublePrecision("dns_ms"),
    tcpMs: doublePrecision("tcp_ms"),
    tlsMs: doublePrecision("tls_ms"),
    ttfbMs: doublePrecision("ttfb_ms"),
    transferMs: doublePrecision("transfer_ms"),
    totalMs: doublePrecision("total_ms").notNull(),

    responseSizeBytes: bigint("response_size_bytes", { mode: "number" }),
    resolvedIp: inet("resolved_ip"),
    certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),

    /** Captured only on failure, for the incident forensics panel. */
    bodySnippet: text("body_snippet"),
    responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.checkedAt] }),
    index("checks_monitor_checked_idx").on(table.monitorId, table.checkedAt.desc()),
    index("checks_monitor_region_checked_idx").on(
      table.monitorId,
      table.regionCode,
      table.checkedAt.desc(),
    ),
    index("checks_cycle_idx").on(table.cycleId),
  ],
);

/**
 * Dead letters for check jobs that exhausted their retry budget.
 *
 * Deliberately unpartitioned: unlike `checks` this stays small, and operators
 * need to query it by `failed_at` across all time without partition pruning.
 * The full job payload is kept so a fixed job can be replayed verbatim.
 */
export const checkJobFailures = pgTable(
  "check_job_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    regionCode: text("region_code").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(0),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("check_job_failures_failed_at_idx").on(table.failedAt)],
);

/** 5-minute pre-aggregates. Drives the dashboard without touching raw rows. */
export const checkRollups5m = pgTable(
  "check_rollups_5m",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    regionCode: text("region_code").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
    okCount: integer("ok_count").notNull(),
    p50Ms: doublePrecision("p50_ms"),
    p95Ms: doublePrecision("p95_ms"),
    p99Ms: doublePrecision("p99_ms"),
    maxMs: doublePrecision("max_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.regionCode, table.bucket] }),
    index("rollups_5m_monitor_bucket_idx").on(table.monitorId, table.bucket.desc()),
  ],
);

/** Hourly pre-aggregates, kept 13 months for long-range SLO views. */
export const checkRollups1h = pgTable(
  "check_rollups_1h",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    regionCode: text("region_code").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
    okCount: integer("ok_count").notNull(),
    p50Ms: doublePrecision("p50_ms"),
    p95Ms: doublePrecision("p95_ms"),
    p99Ms: doublePrecision("p99_ms"),
    maxMs: doublePrecision("max_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.regionCode, table.bucket] }),
    index("rollups_1h_monitor_bucket_idx").on(table.monitorId, table.bucket.desc()),
  ],
);

/**
 * Rolling 7-day p95 baseline per monitor+region, refreshed by the scheduler.
 * Degradation alerts compare recent 5m buckets against this.
 */
export const latencyBaselines = pgTable(
  "latency_baselines",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    regionCode: text("region_code").notNull(),
    p95Ms: doublePrecision("p95_ms").notNull(),
    sampleCount: integer("sample_count").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.regionCode] })],
);
