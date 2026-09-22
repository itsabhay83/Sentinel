import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth";

export const monitorTypeEnum = pgEnum("monitor_type", [
  "http",
  "tcp",
  "ping",
  "dns",
  "heartbeat",
  "flow",
]);

export const monitorStatusEnum = pgEnum("monitor_status", [
  "UP",
  "DEGRADED",
  "PARTIAL_OUTAGE",
  "DOWN",
  "PAUSED",
  "INCONCLUSIVE",
  "PENDING",
]);

export const regionHealthEnum = pgEnum("region_health_status", [
  "healthy",
  "degraded",
  "quarantined",
]);

export const assertionKindEnum = pgEnum("assertion_kind", [
  "keyword",
  "not_keyword",
  "jsonpath",
  "header",
  "response_time",
]);

/** Probe regions. lat/lng drives the dashboard map. */
export const regions = pgTable("regions", {
  code: text("code").primaryKey(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  healthStatus: regionHealthEnum("health_status").notNull().default("healthy"),
  /** Set when quarantine trips; cleared on recovery. */
  quarantinedUntil: timestamp("quarantined_until", { withTimezone: true }),
  quarantineReason: text("quarantine_reason"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: monitorTypeEnum("type").notNull().default("http"),

    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    /** AES-256-GCM ciphertext — headers may carry API tokens. */
    headersEncrypted: text("headers_encrypted"),
    /** AES-256-GCM ciphertext — bodies may carry credentials. */
    bodyEncrypted: text("body_encrypted"),

    intervalSeconds: integer("interval_seconds").notNull().default(60),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    followRedirects: boolean("follow_redirects").notNull().default(true),
    maxRedirects: integer("max_redirects").notNull().default(5),
    expectedStatusCodes: integer("expected_status_codes")
      .array()
      .notNull()
      .default(sql`'{200,201,202,204}'::integer[]`),

    quorumRatio: numeric("quorum_ratio", { precision: 3, scale: 2 }).notNull().default("0.60"),
    minRegionsRequired: integer("min_regions_required").notNull().default(2),
    confirmationFailures: integer("confirmation_failures").notNull().default(2),
    confirmationSuccesses: integer("confirmation_successes").notNull().default(2),
    /** null = use the rolling statistical baseline instead of a fixed threshold. */
    degradedThresholdMs: integer("degraded_threshold_ms"),

    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    groupName: text("group_name"),
    paused: boolean("paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("monitors_org_idx").on(table.organizationId),
    index("monitors_org_paused_idx").on(table.organizationId, table.paused),
  ],
);

/** Which regions probe a given monitor. Composite PK per spec. */
export const monitorRegions = pgTable(
  "monitor_regions",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    regionCode: text("region_code")
      .notNull()
      .references(() => regions.code, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.regionCode] }),
    index("monitor_regions_region_idx").on(table.regionCode),
  ],
);

export const assertions = pgTable(
  "assertions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    kind: assertionKindEnum("kind").notNull(),
    /** JSONPath expression, header name, or null for a body keyword. */
    target: text("target"),
    operator: text("operator").notNull(),
    value: text("value").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
  },
  (table) => [index("assertions_monitor_idx").on(table.monitorId)],
);

/**
 * Hot scheduling row — one per monitor. The scheduler claims work with
 * `SELECT ... WHERE next_run_at <= now() FOR UPDATE SKIP LOCKED` against the
 * partial index below.
 */
export const monitorState = pgTable(
  "monitor_state",
  {
    monitorId: uuid("monitor_id")
      .primaryKey()
      .references(() => monitors.id, { onDelete: "cascade" }),
    status: monitorStatusEnum("status").notNull().default("PENDING"),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    currentIncidentId: uuid("current_incident_id"),
    /** Set while a dispatch cycle is in flight so consensus can fan results in. */
    currentCycleId: uuid("current_cycle_id"),
    /** Regions currently reporting failure — powers the PARTIAL_OUTAGE label. */
    failingRegions: text("failing_regions").array().notNull().default(sql`'{}'::text[]`),
    lastLatencyMs: doublePrecision("last_latency_ms"),
  },
  (table) => [
    index("monitor_state_next_run_idx").on(table.nextRunAt),
    index("monitor_state_status_idx").on(table.status),
  ],
);

/**
 * Single-row fencing register for the scheduler leader lock.
 *
 * The Redis lease alone cannot stop a paused-then-resumed leader from writing
 * after its lease expired. `fencing_token` is bumped on every acquisition, and
 * writes carry the token they were elected with, so a stale leader's work is
 * rejected by a token comparison rather than by trusting wall-clock timing.
 */
export const schedulerLeadership = pgTable("scheduler_leadership", {
  /** Always the literal 'global' — the table holds exactly one row. */
  id: text("id").primaryKey(),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
  holderId: text("holder_id"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
});

/** TLS certificate + domain registration expiry tracking. */
export const monitorCertificates = pgTable("monitor_certificates", {
  monitorId: uuid("monitor_id")
    .primaryKey()
    .references(() => monitors.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
  certIssuer: text("cert_issuer"),
  certSubject: text("cert_subject"),
  domain: text("domain"),
  domainExpiresAt: timestamp("domain_expires_at", { withTimezone: true }),
  registrar: text("registrar"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  /** Highest expiry alert already sent (30/14/7/1) so each fires once. */
  lastAlertedDayBucket: integer("last_alerted_day_bucket"),
});

/** Dead-man's-switch monitors for cron jobs. */
export const heartbeats = pgTable(
  "heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    expectedEverySeconds: integer("expected_every_seconds").notNull().default(3600),
    graceSeconds: integer("grace_seconds").notNull().default(300),
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
    pingToken: text("ping_token").notNull(),
  },
  (table) => [
    uniqueIndex("heartbeats_token_unique").on(table.pingToken),
    uniqueIndex("heartbeats_monitor_unique").on(table.monitorId),
  ],
);

/** Multi-step API flows with `{{step1.body.token}}` variable chaining. */
export const flowSteps = pgTable(
  "flow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    headersEncrypted: text("headers_encrypted"),
    bodyEncrypted: text("body_encrypted"),
    expectedStatusCodes: integer("expected_status_codes")
      .array()
      .notNull()
      .default(sql`'{200,201,202,204}'::integer[]`),
    /** { varName: "$.token" } — JSONPath extractions exposed to later steps. */
    extract: jsonb("extract").$type<Record<string, string>>().notNull().default({}),
  },
  (table) => [
    uniqueIndex("flow_steps_monitor_order_unique").on(table.monitorId, table.orderIndex),
  ],
);

export const slos = pgTable(
  "slos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    targetPercent: numeric("target_percent", { precision: 6, scale: 3 }).notNull().default("99.900"),
    windowDays: integer("window_days").notNull().default(30),
  },
  (table) => [uniqueIndex("slos_monitor_unique").on(table.monitorId)],
);

export const monitorsRelations = relations(monitors, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [monitors.organizationId],
    references: [organizations.id],
  }),
  state: one(monitorState, {
    fields: [monitors.id],
    references: [monitorState.monitorId],
  }),
  regions: many(monitorRegions),
  assertions: many(assertions),
  slo: one(slos, { fields: [monitors.id], references: [slos.monitorId] }),
  certificate: one(monitorCertificates, {
    fields: [monitors.id],
    references: [monitorCertificates.monitorId],
  }),
}));

export const monitorRegionsRelations = relations(monitorRegions, ({ one }) => ({
  monitor: one(monitors, { fields: [monitorRegions.monitorId], references: [monitors.id] }),
  region: one(regions, { fields: [monitorRegions.regionCode], references: [regions.code] }),
}));

export const monitorStateRelations = relations(monitorState, ({ one }) => ({
  monitor: one(monitors, { fields: [monitorState.monitorId], references: [monitors.id] }),
}));
