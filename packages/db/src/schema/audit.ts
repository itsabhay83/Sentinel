import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeys, organizations, users } from "./auth";

/**
 * Append-only security audit trail.
 *
 * Actor identity is denormalised into `actor_email` because the trail has to
 * outlive the account it describes: deleting a user nulls `actor_user_id` but
 * must not erase who performed which action. `organization_id` is nullable
 * because pre-tenancy events — a failed login for an address that matches no
 * account — belong to no organisation.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    /** user | api_key | system */
    actorType: text("actor_type").notNull().default("user"),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Dotted event name, e.g. `auth.login.success`, `member.role.changed`. */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_org_created_idx").on(table.organizationId, table.createdAt.desc()),
    index("audit_logs_actor_created_idx").on(table.actorUserId, table.createdAt.desc()),
    index("audit_logs_action_created_idx").on(table.action, table.createdAt.desc()),
  ],
);
