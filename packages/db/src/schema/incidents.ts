import { relations, sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { monitors } from "./monitors";

export const incidentSeverityEnum = pgEnum("incident_severity", ["down", "partial", "degraded"]);

export const incidentEventKindEnum = pgEnum("incident_event_kind", [
  "opened",
  "region_failed",
  "region_recovered",
  "escalated",
  "acked",
  "resolved",
  "note",
  "flapping_detected",
  "severity_changed",
]);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    severity: incidentSeverityEnum("severity").notNull(),
    primaryFailureCode: text("primary_failure_code"),
    affectedRegions: text("affected_regions").array().notNull().default(sql`'{}'::text[]`),
    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    postmortem: text("postmortem"),
    /** Set when flap suppression folds repeated short incidents into one. */
    isFlapping: text("is_flapping"),
  },
  (table) => [
    index("incidents_monitor_started_idx").on(table.monitorId, table.startedAt.desc()),
    index("incidents_open_idx")
      .on(table.monitorId, table.startedAt.desc())
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export const incidentEvents = pgTable(
  "incident_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: incidentEventKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [index("incident_events_incident_at_idx").on(table.incidentId, table.at)],
);

export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  monitor: one(monitors, { fields: [incidents.monitorId], references: [monitors.id] }),
  events: many(incidentEvents),
}));

export const incidentEventsRelations = relations(incidentEvents, ({ one }) => ({
  incident: one(incidents, { fields: [incidentEvents.incidentId], references: [incidents.id] }),
}));
