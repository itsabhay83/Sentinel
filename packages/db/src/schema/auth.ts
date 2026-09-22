import { relations } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Identity and tenancy.
 *
 * Table and column names follow Better Auth's expectations (it maps model
 * fields to the JS keys below), extended with Sentinel-specific columns such
 * as `organization.plan`.
 */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /** Bumped on every authenticated request; drives the idle timeout. */
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  /** Null means the second factor is outstanding — such a session is not fully authenticated. */
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
}, (table) => [
  uniqueIndex("sessions_token_unique").on(table.token),
  index("sessions_user_id_idx").on(table.userId),
]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("accounts_user_id_idx").on(table.userId)]);

/**
 * Single-use tokens for password reset and email verification.
 *
 * `value` holds a SHA-256 hash of the token (see hashToken in @sentinel/shared),
 * never the token itself, so a database read cannot be replayed as a reset link.
 * `purpose` defaults to the weaker capability on purpose: a row that somehow
 * lands without an explicit purpose fails a `password_reset` lookup rather than
 * satisfying one.
 */
export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  /** password_reset | email_verification */
  purpose: text("purpose").notNull().default("email_verification"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("verifications_identifier_idx").on(table.identifier),
  uniqueIndex("verifications_value_unique").on(table.value),
  index("verifications_identifier_purpose_idx").on(table.identifier, table.purpose),
]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logo: text("logo"),
  metadata: text("metadata"),
  /** Billing seam — read by limitsFor() in @sentinel/shared. */
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("organizations_slug_unique").on(table.slug)]);

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** owner | admin | member | viewer */
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("members_org_user_unique").on(table.organizationId, table.userId),
  index("members_user_id_idx").on(table.userId),
]);

export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
}, (table) => [index("invitations_org_idx").on(table.organizationId)]);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** HMAC-SHA256 of the key. Plaintext is shown to the user exactly once. */
  hashedKey: text("hashed_key").notNull(),
  /** Human-readable prefix so users can identify a key in a list. */
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** Set on the successor key during a rotation, so both stay valid until the old one is revoked. */
  rotatedFromId: uuid("rotated_from_id").references((): AnyPgColumn => apiKeys.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("api_keys_hashed_key_unique").on(table.hashedKey),
  index("api_keys_org_idx").on(table.organizationId),
]);

/**
 * TOTP enrolment. `secret_encrypted` is AES-256-GCM ciphertext — a plaintext
 * shared secret in this column would let a database reader mint valid codes.
 * `confirmed_at` stays null until the user proves a working code, so a
 * half-finished enrolment can never lock anyone out.
 */
export const userMfaFactors = pgTable("user_mfa_factors", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** totp */
  type: text("type").notNull().default("totp"),
  secretEncrypted: text("secret_encrypted").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("user_mfa_factors_user_type_unique").on(table.userId, table.type)]);

export const userRecoveryCodes = pgTable("user_recovery_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("user_recovery_codes_user_idx").on(table.userId)]);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(members),
  sessions: many(sessions),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(members),
  apiKeys: many(apiKeys),
}));

export const membersRelations = relations(members, ({ one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [members.userId], references: [users.id] }),
}));
