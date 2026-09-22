import "server-only";

import { headers } from "next/headers";

import { db } from "@sentinel/db";
import { auditLogs } from "@sentinel/db/schema";

export type AuditActorType = "user" | "api_key" | "system";

/** Enumerated at runtime as well as in the type so the audit viewer can offer them as filters. */
export const AUDIT_ACTIONS = [
  "auth.login.success",
  "auth.login.failed",
  "auth.logout",
  "auth.signup",
  "auth.password.changed",
  "auth.password.reset.requested",
  "auth.password.reset.completed",
  "auth.email.verification.sent",
  "auth.email.verified",
  "auth.mfa.enrolled",
  "auth.mfa.disabled",
  "auth.mfa.challenge.failed",
  "auth.mfa.recovery_code.used",
  "auth.sessions.revoked_all",
  "auth.session.revoked",
  "account.deleted",
  "org.created",
  "org.deleted",
  "org.data.exported",
  "member.invited",
  "member.invite.revoked",
  "member.joined",
  "member.removed",
  "member.role.changed",
  "member.ownership.transferred",
  "api_key.created",
  "api_key.revoked",
  "api_key.rotated",
  "monitor.created",
  "monitor.updated",
  "monitor.deleted",
  "monitor.paused",
  "monitor.resumed",
  "alert_channel.created",
  "alert_channel.updated",
  "alert_channel.deleted",
  "status_page.created",
  "status_page.updated",
  "status_page.deleted",
  "status_page.password.changed",
  "maintenance_window.created",
  "maintenance_window.updated",
  "maintenance_window.cancelled",
  "maintenance_window.published",
  "maintenance_window.unpublished",
  "slo.created",
  "slo.updated",
  "slo.deleted",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditEntry {
  action: AuditAction;
  organizationId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorType?: AuditActorType;
  apiKeyId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Never throws. An audit write failing must not roll back or block the action
 * it describes — a user locked out of logout because the audit table is full
 * is a worse outcome than a gap in the trail. Failures are logged instead.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const hdrs = await headers();
    await db.insert(auditLogs).values({
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorType: entry.actorType ?? "user",
      apiKeyId: entry.apiKeyId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? null,
      userAgent: hdrs.get("user-agent"),
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("[audit] failed to record entry", { action: entry.action, error });
  }
}
