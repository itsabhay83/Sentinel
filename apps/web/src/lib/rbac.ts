import "server-only";

import { requireOrg, type SessionOrg, type SessionUser } from "@/lib/auth";

/**
 * Role enforcement for the four roles `members.role` has always documented but
 * never checked. `resolveOrg()` already selects the role into the session, so
 * this file is only the comparison and the two shapes call sites need: a
 * throwing guard for `(id) => Promise<void>` actions and a returning guard for
 * `useActionState` actions that must surface the refusal as form state.
 *
 * Ranks are a total order rather than a permission matrix because every
 * privilege in the product so far is cumulative — an owner can do everything an
 * admin can. Introduce a matrix when that stops being true, not before.
 */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Unknown role strings rank lowest so a bad row fails closed, never open. */
function rankOf(role: string): number {
  return RANK[role as Role] ?? -1;
}

export function hasRole(role: string, minimum: Role): boolean {
  return rankOf(role) >= RANK[minimum];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

const DENIED: Record<Role, string> = {
  viewer: "You do not have access to this organization.",
  member: "Your role does not allow this change.",
  admin: "Only an admin or owner can do that.",
  owner: "Only the owner can do that.",
};

/**
 * For form actions. Returns the refusal as data so `useActionState` can render
 * it, matching how every other action in the app reports a rejected write.
 *
 * `ok` is a literal discriminant rather than a nullable `error`: narrowing on
 * the error string alone leaves the failure branch in the union, since an empty
 * message is falsy, and callers then see `org` as possibly undefined.
 */
export type RoleGuard =
  | { ok: true; org: SessionOrg; user: SessionUser }
  | { ok: false; error: string };

export async function guardRole(minimum: Role): Promise<RoleGuard> {
  const session = await requireOrg();
  if (!hasRole(session.org.role, minimum)) return { ok: false, error: DENIED[minimum] };
  return { ok: true, org: session.org, user: session.user };
}

/**
 * For `(id) => Promise<void>` actions bound to a plain form. These have nowhere
 * to render an error, and the UI does not render the control for roles that
 * cannot use it, so reaching here means the request was forged — throwing to
 * the error boundary is the correct outcome.
 */
export async function requireRole(minimum: Role): Promise<{ org: SessionOrg; user: SessionUser }> {
  const session = await requireOrg();
  if (!hasRole(session.org.role, minimum)) throw new Error(DENIED[minimum]);
  return { org: session.org, user: session.user };
}

export function assignableRoles(actorRole: string): Role[] {
  const base: Role[] = ["admin", "member", "viewer"];
  return actorRole === "owner" ? ["owner", ...base] : base;
}

export function normalizeRole(value: string): Role {
  return isRole(value) ? value : "viewer";
}
