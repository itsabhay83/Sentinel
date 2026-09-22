import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth";
import { incidents } from "./incidents";
import { monitors } from "./monitors";

export const alertChannelKindEnum = pgEnum("alert_channel_kind", [
  "email",
  "slack",
  "discord",
  "webhook",
]);

/**
 * `sending` is the claim marker: one scheduler flips a row into it so a peer's
 * `WHERE status = 'pending'` claim cannot pick up the same delivery. `failed`
 * is retryable; `dead` is terminal — the retry budget is spent and no worker
 * will pick the row up again.
 */
export const alertDeliveryStatusEnum = pgEnum("alert_delivery_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "suppressed",
  "dead",
]);

export const alertChannels = pgTable(
  "alert_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: alertChannelKindEnum("kind").notNull(),
    /** { email } | { webhookUrl } | { url, signingSecret } — secrets encrypted. */
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("alert_channels_org_idx").on(table.organizationId)],
);

export const escalationPolicies = pgTable(
  "escalation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("escalation_policies_org_idx").on(table.organizationId)],
);

export const escalationSteps = pgTable(
  "escalation_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => escalationPolicies.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    /** Minutes after incident open before this step fires. 0 = immediately. */
    afterMinutes: integer("after_minutes").notNull().default(0),
    channelIds: uuid("channel_ids").array().notNull().default(sql`'{}'::uuid[]`),
  },
  (table) => [index("escalation_steps_policy_idx").on(table.policyId, table.orderIndex)],
);

export const monitorPolicies = pgTable(
  "monitor_policies",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => escalationPolicies.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.policyId] })],
);

export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => alertChannels.id, { onDelete: "cascade" }),
    /** open | resolve | escalate — one row per (incident, channel, kind). */
    kind: text("kind").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    status: alertDeliveryStatusEnum("status").notNull().default("pending"),
    responseCode: integer("response_code"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** Null means "not scheduled for retry" — the worker polls for a due timestamp, so null rows are invisible to it. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    index("alert_deliveries_incident_idx").on(table.incidentId),
    /** The delivery worker's only claim query: due retries, oldest first. */
    index("alert_deliveries_retry_idx").on(table.status, table.nextAttemptAt),
    /** UNIQUE is load-bearing: schedulers claim deliveries with ON CONFLICT DO NOTHING. */
    uniqueIndex("alert_deliveries_dedup_idx").on(
      table.incidentId,
      table.channelId,
      table.kind,
      table.stepIndex,
    ),
  ],
);

export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    monitorIds: uuid("monitor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** iCal RRULE for recurring windows; null = one-off. */
    rrule: text("rrule"),
    reason: text("reason").notNull().default(""),
    /** scheduled | in_progress | completed | cancelled */
    status: text("status").notNull().default("scheduled"),
    /** Null keeps the window private — status pages only render published maintenance. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("maintenance_windows_org_idx").on(table.organizationId),
    index("maintenance_windows_time_idx").on(table.startsAt, table.endsAt),
  ],
);

export const alertChannelsRelations = relations(alertChannels, ({ one }) => ({
  organization: one(organizations, {
    fields: [alertChannels.organizationId],
    references: [organizations.id],
  }),
}));

export const escalationPoliciesRelations = relations(escalationPolicies, ({ many }) => ({
  steps: many(escalationSteps),
}));

export const escalationStepsRelations = relations(escalationSteps, ({ one }) => ({
  policy: one(escalationPolicies, {
    fields: [escalationSteps.policyId],
    references: [escalationPolicies.id],
  }),
}));
