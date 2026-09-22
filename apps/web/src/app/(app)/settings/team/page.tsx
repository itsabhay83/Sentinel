import type { Metadata } from "next";
import { MailCheck } from "lucide-react";
import { sql as rawSql } from "@sentinel/db";
import { limitsFor } from "@sentinel/shared";
import { InviteForm, MemberRoleForm } from "@/components/team-forms";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { removeMemberAction, revokeInvitationAction } from "@/lib/actions/team";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { assignableRoles, hasRole } from "@/lib/rbac";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

export default async function TeamSettings() {
  const { org, user } = await requireOrg();

  const [members, invitations] = await Promise.all([
    rawSql<{ id: string; user_id: string; name: string; email: string; role: string; created_at: Date }[]>`
      SELECT mem.id, mem.user_id, u.name, u.email, mem.role, mem.created_at
      FROM members mem
      JOIN users u ON u.id = mem.user_id
      WHERE mem.organization_id = ${org.id}
      ORDER BY mem.created_at
    `,
    rawSql<{ id: string; email: string; role: string; expires_at: Date; inviter: string }[]>`
      SELECT i.id, i.email, i.role, i.expires_at, u.name AS inviter
      FROM invitations i
      JOIN users u ON u.id = i.inviter_id
      WHERE i.organization_id = ${org.id} AND i.status = 'pending' AND i.expires_at > now()
      ORDER BY i.expires_at DESC
    `,
  ]);

  const canManage = hasRole(org.role, "admin");
  const limits = limitsFor(org.plan);
  const seatsUsed = members.length + invitations.length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-xl font-semibold text-ink">Team</h1>
      <p className="mt-1 text-sm text-ink-2">
        {seatsUsed} of {limits.maxTeamMembers} seats used on the {org.plan} plan.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {m.name}
                      {m.user_id === user.id && <span className="ml-1.5 text-xs text-ink-3">(you)</span>}
                    </span>
                    <span className="block truncate text-xs text-ink-3">{m.email}</span>
                  </span>
                  <span className="text-xs text-ink-3">joined {relativeTime(m.created_at)}</span>
                  {canManage && m.user_id !== user.id ? (
                    <>
                      <MemberRoleForm csrf={<CsrfInput />} memberId={m.id} role={m.role} roles={assignableRoles(org.role)} />
                      <form action={removeMemberAction.bind(null, m.id)}>
                        <Button type="submit" variant="ghost" size="sm">
                          Remove
                        </Button>
                      </form>
                    </>
                  ) : (
                    <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending invitations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {invitations.length === 0 && <p className="py-6 text-center text-sm text-ink-3">No invitations outstanding.</p>}
              {invitations.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <MailCheck className="size-4 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.email}</span>
                  <Badge tone="neutral">{i.role}</Badge>
                  <span className="text-xs text-ink-3">expires {formatDateTime(i.expires_at)}</span>
                  {canManage && (
                    <form action={revokeInvitationAction.bind(null, i.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Revoke
                      </Button>
                    </form>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {canManage && <InviteForm csrf={<CsrfInput />} roles={assignableRoles(org.role)} />}
      </div>
    </div>
  );
}
