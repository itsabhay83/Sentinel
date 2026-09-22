"use server";

/**
 * Data portability and erasure.
 *
 * Both deletions rely on `ON DELETE CASCADE` from `organizations` and `users`,
 * with two documented exceptions that have no foreign key at all and would
 * otherwise be left behind:
 *
 *  - `checks` is `PARTITION BY RANGE` and declares no reference to `monitors`,
 *    so its rows survive the monitor they describe. Deleted explicitly.
 *  - `verifications` is keyed by email address, not by user id. An unconsumed
 *    password-reset row would outlive the account and stay redeemable against a
 *    future account that registers the same address. Deleted explicitly.
 *
 * `sessions.active_organization_id` is likewise unconstrained; it is nulled
 * rather than deleted, because a co-member's session must survive losing one of
 * their organizations.
 */

import { revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { sql as rawSql } from "@sentinel/db";
import { z } from "zod";
import { planAccountDeletion } from "@/lib/account-deletion";
import { recordAudit } from "@/lib/audit";
import { clerkClient } from "@clerk/nextjs/server";

import { requireSession } from "@/lib/auth";
import { assertCsrf } from "@/lib/csrf";
import { buildOrganizationExport } from "@/lib/data-export";
import { STATUS_PAGE_CACHE_TAG } from "@/lib/queries";
import { checkPlanRateLimit, retryAfterMessage } from "@/lib/ratelimit";
import { guardRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const confirmSchema = z.object({ confirm: z.string().trim().min(1) });

const EXPORTS_PER_MINUTE = 5;

/**
 * The payload rides back in `secret` because it is exactly what that field is
 * for: a value the server materialises once and that no page can re-read.
 */
export async function exportOrganizationDataAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  // There is no dedicated export policy and RATE_LIMIT_POLICIES is owned
  // elsewhere, so this borrows the generic read policy under its own subject
  // key and scales it down — a full-tenant dump must not be loopable.
  const rate = await checkPlanRateLimit("apiRead", `org-export:${org.id}`, EXPORTS_PER_MINUTE);
  if (!rate.allowed) return { error: retryAfterMessage(rate) };

  const payload = await buildOrganizationExport(org.id);
  if (!payload) return { error: "Organization not found" };

  await recordAudit({
    action: "org.data.exported",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "organization",
    targetId: org.id,
    metadata: { monitors: payload.monitors.length, incidents: payload.incidents.length },
  });

  return { ok: true, secret: JSON.stringify(payload, null, 2) };
}

export async function deleteOrganizationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("owner");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  // Mirrors the ownership-transfer gate in actions/team.ts: the rank ladder is
  // cumulative, so this is the one place a literal role comparison is warranted.
  if (org.role !== "owner") return { error: "Only the owner can delete an organization." };

  const parsed = confirmSchema.safeParse({ confirm: formData.get("confirm") });
  if (!parsed.success || parsed.data.confirm !== org.slug) {
    return { error: `Type ${org.slug} exactly to confirm.` };
  }

  // Written first and deliberately detached from the organization:
  // audit_logs.organization_id cascades, so a row filed against org.id would be
  // destroyed by the very statement it documents.
  await recordAudit({
    action: "org.deleted",
    organizationId: null,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "organization",
    targetId: org.id,
    metadata: { slug: org.slug, name: org.name },
  });

  await rawSql.begin(async (tx) => {
    await tx`
      DELETE FROM checks
      WHERE monitor_id IN (SELECT id FROM monitors WHERE organization_id = ${org.id})
    `;
    await tx`DELETE FROM organizations WHERE id = ${org.id}`;
  });

  // The public status page is cached for 30s; a deleted tenant must stop being
  // served from that cache immediately, not eventually.
  revalidateTag(STATUS_PAGE_CACHE_TAG);
  redirect("/dashboard");
}

export async function deleteAccountAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const session = await requireSession();
  const email = session.user.email.toLowerCase();
  const parsed = confirmSchema.safeParse({ confirm: formData.get("confirm") });
  if (!parsed.success || parsed.data.confirm.toLowerCase() !== email) {
    return { error: "Type your email address exactly to confirm." };
  }

  const plan = await planAccountDeletion(session.user.id);
  if (plan.blockedBy.length > 0) {
    return {
      error: `You are the only owner of ${plan.blockedBy.join(", ")}. Transfer ownership or delete ${
        plan.blockedBy.length === 1 ? "it" : "them"
      } first.`,
    };
  }

  await recordAudit({
    action: "account.deleted",
    organizationId: null,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    targetType: "user",
    targetId: session.user.id,
    metadata: { organizationsDeleted: plan.soleMemberOrgIds },
  });

  await rawSql.begin(async (tx) => {
    if (plan.soleMemberOrgIds.length > 0) {
      await tx`
        DELETE FROM checks
        WHERE monitor_id IN (
          SELECT id FROM monitors WHERE organization_id = ANY(${plan.soleMemberOrgIds}::text[])
        )
      `;
      await tx`DELETE FROM organizations WHERE id = ANY(${plan.soleMemberOrgIds}::text[])`;
    }
    await tx`DELETE FROM users WHERE id = ${session.user.id}`;
  });

  // The local row is gone, but the Clerk user is the actual account -- leaving
  // it would let the same person sign straight back in and be re-provisioned by
  // ensureMembership(), which is the opposite of deleting an account. Clerk
  // revokes their sessions as part of this.
  const clerk = await clerkClient();
  await clerk.users.deleteUser(session.user.id);

  revalidateTag(STATUS_PAGE_CACHE_TAG);
  redirect("/");
}
