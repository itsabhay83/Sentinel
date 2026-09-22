import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { alertDeliveryStatusEnum } from "./alerting";
import { organizations } from "./auth";
import { incidents } from "./incidents";
import { monitors } from "./monitors";

export const statusPages = pgTable(
  "status_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    customDomain: text("custom_domain"),
    /** Random token the customer puts in a TXT record to prove domain control. */
    domainVerificationToken: text("domain_verification_token"),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    theme: jsonb("theme").$type<Record<string, string>>().notNull().default({}),
    /** bcrypt-style hash; null = public page. */
    passwordHash: text("password_hash"),
    showUptimeDays: integer("show_uptime_days").notNull().default(90),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("status_pages_slug_unique").on(table.slug),
    uniqueIndex("status_pages_custom_domain_unique").on(table.customDomain),
    index("status_pages_org_idx").on(table.organizationId),
  ],
);

export const statusPageMonitors = pgTable(
  "status_page_monitors",
  {
    statusPageId: uuid("status_page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    /** Public-facing name — never leaks the internal monitor name or URL. */
    displayName: text("display_name").notNull(),
    groupName: text("group_name").notNull().default("Services"),
    orderIndex: integer("order_index").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.statusPageId, table.monitorId] }),
    index("status_page_monitors_page_idx").on(table.statusPageId, table.orderIndex),
  ],
);

export const statusPageSubscribers = pgTable(
  "status_page_subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statusPageId: uuid("status_page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Confirmed opt-in: null until the subscriber clicks the emailed link. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmToken: text("confirm_token").notNull(),
    unsubscribeToken: text("unsubscribe_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("status_page_subscribers_unique").on(table.statusPageId, table.email),
    uniqueIndex("status_page_subscribers_confirm_token").on(table.confirmToken),
    uniqueIndex("status_page_subscribers_unsub_token").on(table.unsubscribeToken),
  ],
);

/**
 * Per-subscriber delivery ledger for status page incident mail.
 *
 * This cannot reuse `alert_deliveries`: that table's `channel_id` is a NOT NULL
 * reference to `alert_channels`, and a subscriber is not a channel. A timestamp
 * on the incident would not work either — every subscriber gets a personal
 * unsubscribe link and therefore a separate send, so a crash mid-fan-out would
 * re-mail everyone who already received it. One row per (incident, subscriber,
 * kind) makes the fan-out resumable and exactly-once.
 */
export const statusPageNotifications = pgTable(
  "status_page_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => statusPageSubscribers.id, { onDelete: "cascade" }),
    /** open | resolve — one row per (incident, subscriber, kind). */
    kind: text("kind").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    status: alertDeliveryStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** Null means "not scheduled for retry" — the worker polls for a due timestamp, so null rows are invisible to it. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    index("status_page_notifications_status_idx").on(table.status),
    /** The subscriber mailer's claim query: due retries, oldest first. */
    index("status_page_notifications_retry_idx").on(table.status, table.nextAttemptAt),
    /** UNIQUE is load-bearing: the fan-out claims rows with ON CONFLICT DO NOTHING. */
    uniqueIndex("status_page_notifications_dedup_idx").on(
      table.incidentId,
      table.subscriberId,
      table.kind,
    ),
  ],
);

export const statusPagesRelations = relations(statusPages, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [statusPages.organizationId],
    references: [organizations.id],
  }),
  monitors: many(statusPageMonitors),
}));

export const statusPageMonitorsRelations = relations(statusPageMonitors, ({ one }) => ({
  statusPage: one(statusPages, {
    fields: [statusPageMonitors.statusPageId],
    references: [statusPages.id],
  }),
  monitor: one(monitors, {
    fields: [statusPageMonitors.monitorId],
    references: [monitors.id],
  }),
}));
