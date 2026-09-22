"use server";

/**
 * Team membership. The `invitations` table shipped in the schema but had no
 * writer, so every organization was permanently single-user.
 *
 * The invitation row id is the link token. It is `generateId()`, i.e. 96 bits
 * of CSPRNG, so it is unguessable, and reusing it avoids a second column that
 * would have to be kept in sync with the row it authorises. Acceptance still
 * requires a session whose email matches the invited address, so a forwarded or
 * leaked link cannot be redeemed by whoever happens to open it.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql as rawSql } from "@sentinel/db";
import { limitsFor } from "@sentinel/shared";
import { generateId } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { getSession } from "@/lib/auth";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { stashInvite } from "@/lib/invite-cookie";
import { appUrl, sendMail } from "@/lib/mail";
import { checkRateLimit, retryAfterMessage } from "@/lib/ratelimit";
import { guardRole, requireRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const TEAM_PATH = "/settings/team";
const INVITE_TTL_DAYS = 7;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(["admin", "member", "viewer"]),
});

/**
 * Owner is deliberately not invitable. Transferring ownership is a different
 * operation with different consequences than adding a teammate, and conflating
 * them behind one dropdown is how organizations end up with two owners nobody
 * intended.
 */
export async function inviteMemberAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { email, role } = parsed.data;

  const rate = await checkRateLimit("inviteSend", org.id);
  if (!rate.allowed) return { error: retryAfterMessage(rate) };

  const [existing] = await rawSql<{ id: string }[]>`
    SELECT m.id FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${org.id} AND lower(u.email) = ${email}
  `;
  if (existing) return { error: "That person is already on the team." };

  // Seats are counted as members plus outstanding invitations, so a burst of
  // invites cannot overshoot the plan cap once they are all accepted.
  const limits = limitsFor(org.plan);
  const [seats] = await rawSql<{ used: number }[]>`
    SELECT (
      (SELECT count(*) FROM members WHERE organization_id = ${org.id}) +
      (SELECT count(*) FROM invitations WHERE organization_id = ${org.id} AND status = 'pending' AND expires_at > now())
    )::int AS used
  `;
  if ((seats?.used ?? 0) >= limits.maxTeamMembers) {
    return { error: `Your plan allows ${limits.maxTeamMembers} team members. Upgrade to invite more.` };
  }

  const id = generateId("inv");
  // The table has no unique constraint on (organization_id, email), so a repeat
  // invite supersedes the previous one here rather than accumulating rows that
  // would each remain independently redeemable.
  await rawSql.begin(async (tx) => {
    await tx`
      UPDATE invitations SET status = 'revoked'
      WHERE organization_id = ${org.id} AND email = ${email} AND status = 'pending'
    `;
    await tx`
      INSERT INTO invitations (id, organization_id, email, role, status, expires_at, inviter_id)
      VALUES (${id}, ${org.id}, ${email}, ${role}, 'pending', now() + ${`${INVITE_TTL_DAYS} days`}::interval, ${user.id})
    `;
  });

  const link = appUrl(`/invite/${id}`);
  const result = await sendMail({
    to: email,
    subject: `You have been invited to ${org.name} on Sentinel`,
    text: [
      `You have been invited to join ${org.name} on Sentinel as a ${role}.`,
      "",
      link,
      "",
      `This invitation expires in ${INVITE_TTL_DAYS} days.`,
    ].join("\n"),
  });

  await recordAudit({
    action: "member.invited",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "invitation",
    targetId: id,
    metadata: { email, role, delivered: result.delivered },
  });

  // The link is returned either way. Mail delivery is best-effort — an invite
  // the admin can copy and paste is strictly better than a failed action.
  revalidatePath(TEAM_PATH);
  return {
    ok: true,
    secret: result.delivered ? undefined : link,
  };
}

export async function revokeInvitationAction(invitationId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const [row] = await rawSql<{ email: string; role: string }[]>`
    UPDATE invitations SET status = 'revoked'
    WHERE id = ${invitationId} AND organization_id = ${org.id} AND status = 'pending'
    RETURNING email, role
  `;
  if (row) {
    await recordAudit({
      action: "member.invite.revoked",
      organizationId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "invitation",
      targetId: invitationId,
      metadata: { email: row.email, role: row.role },
    });
  }
  revalidatePath(TEAM_PATH);
}

/**
 * Redeeming an invitation. Runs as the invited user, not an admin, so it takes
 * no role guard — the invitation row itself is the authorisation.
 */
export async function acceptInvitationAction(invitationId: string): Promise<void> {
  await assertSameOrigin();

  const session = await getSession();
  if (!session) {
    // An invited person often has no account yet, so park the invitation in a
    // cookie and let either login or signup deliver them back to it.
    await stashInvite(invitationId);
    redirect("/login");
  }

  const [invite] = await rawSql<{ organization_id: string; email: string; role: string }[]>`
    SELECT organization_id, email, role FROM invitations
    WHERE id = ${invitationId} AND status = 'pending' AND expires_at > now()
  `;
  if (!invite || invite.email !== session.user.email.toLowerCase()) {
    redirect(`/invite/${invitationId}?error=invalid`);
  }

  await rawSql.begin(async (tx) => {
    await tx`
      INSERT INTO members (id, organization_id, user_id, role)
      VALUES (${generateId("mem")}, ${invite.organization_id}, ${session.user.id}, ${invite.role})
      ON CONFLICT ON CONSTRAINT members_org_user_unique DO NOTHING
    `;
    await tx`UPDATE invitations SET status = 'accepted' WHERE id = ${invitationId}`;
    // Drop the user straight into the organization they just joined rather than
    // whichever one they happened to have open.
    await tx`
      UPDATE sessions SET active_organization_id = ${invite.organization_id}
      WHERE token = ${session.token}
    `;
  });

  await recordAudit({
    action: "member.joined",
    organizationId: invite.organization_id,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    targetType: "invitation",
    targetId: invitationId,
    metadata: { role: invite.role },
  });

  redirect("/dashboard");
}

const roleChangeSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

export async function changeMemberRoleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  const parsed = roleChangeSchema.safeParse({
    memberId: formData.get("memberId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Invalid input" };
  const { memberId, role } = parsed.data;

  // Only an owner may create another owner or demote one. An admin promoting
  // themselves to owner would otherwise make the role ladder decorative.
  if (role === "owner" && org.role !== "owner") {
    return { error: "Only the owner can transfer ownership." };
  }

  const [target] = await rawSql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM members WHERE id = ${memberId} AND organization_id = ${org.id}
  `;
  if (!target) return { error: "Member not found." };
  if (target.role === "owner" && org.role !== "owner") {
    return { error: "Only the owner can change the owner's role." };
  }
  if (target.user_id === user.id && target.role === "owner" && role !== "owner") {
    const guardError = await wouldOrphanOrg(org.id, memberId);
    if (guardError) return { error: guardError };
  }

  await rawSql`UPDATE members SET role = ${role} WHERE id = ${memberId} AND organization_id = ${org.id}`;

  await recordAudit({
    action: role === "owner" ? "member.ownership.transferred" : "member.role.changed",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "member",
    targetId: memberId,
    metadata: { from: target.role, to: role, targetUserId: target.user_id },
  });

  revalidatePath(TEAM_PATH);
  return { ok: true };
}

export async function removeMemberAction(memberId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const orphan = await wouldOrphanOrg(org.id, memberId);
  if (orphan) throw new Error(orphan);
  const [row] = await rawSql<{ user_id: string; role: string }[]>`
    DELETE FROM members WHERE id = ${memberId} AND organization_id = ${org.id}
    RETURNING user_id, role
  `;
  if (row) {
    await recordAudit({
      action: "member.removed",
      organizationId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "member",
      targetId: memberId,
      metadata: { targetUserId: row.user_id, role: row.role },
    });
  }
  revalidatePath(TEAM_PATH);
}

/**
 * An organization with no owner has no one who can restore an owner, and the
 * `members` rows cascade from `organizations` rather than the other way round,
 * so nothing else in the schema prevents this.
 */
async function wouldOrphanOrg(organizationId: string, memberId: string): Promise<string | null> {
  const [row] = await rawSql<{ owners: number; target_role: string | null }[]>`
    SELECT
      (SELECT count(*) FROM members WHERE organization_id = ${organizationId} AND role = 'owner')::int AS owners,
      (SELECT role FROM members WHERE id = ${memberId} AND organization_id = ${organizationId}) AS target_role
  `;
  if (!row || row.target_role !== "owner") return null;
  return row.owners <= 1 ? "Promote another owner before removing the last one." : null;
}
