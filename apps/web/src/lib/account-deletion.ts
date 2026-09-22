/**
 * What deleting a user account would take with it.
 *
 * `members` cascades from `users`, so a naive account delete silently strips the
 * last owner out of an organization other people still work in — the same
 * orphaning `wouldOrphanOrg` in `actions/team.ts` refuses for member removal.
 * This decides the two cases up front: refuse, or take the organization along.
 */
import "server-only";

import { sql as rawSql } from "@sentinel/db";

export type AccountDeletionPlan = {
  /** Slugs of organizations this user solely owns while others are still members. */
  blockedBy: string[];
  /** Organizations where this user is the only member; they die with the account. */
  soleMemberOrgIds: string[];
};

export async function planAccountDeletion(userId: string): Promise<AccountDeletionPlan> {
  const rows = await rawSql<
    { id: string; slug: string; role: string; member_count: number; owner_count: number }[]
  >`
    SELECT o.id, o.slug, m.role,
           (SELECT count(*) FROM members m2 WHERE m2.organization_id = o.id)::int AS member_count,
           (SELECT count(*) FROM members m3
              WHERE m3.organization_id = o.id AND m3.role = 'owner')::int AS owner_count
    FROM organizations o
    JOIN members m ON m.organization_id = o.id AND m.user_id = ${userId}
    ORDER BY o.slug
  `;

  return {
    blockedBy: rows
      .filter((r) => r.member_count > 1 && r.role === "owner" && r.owner_count === 1)
      .map((r) => r.slug),
    soleMemberOrgIds: rows.filter((r) => r.member_count === 1).map((r) => r.id),
  };
}
