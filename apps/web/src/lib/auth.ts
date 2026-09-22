import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@sentinel/db";
import { members, organizations, users } from "@sentinel/db/schema";
import { generateId } from "@sentinel/shared/server";

/**
 * Session resolution, backed by Clerk.
 *
 * Clerk owns identity — credentials, MFA, email verification, session lifetime
 * and revocation. This module owns the *mapping* from a Clerk user to the local
 * `users`/`members`/`organizations` rows, because every tenant-scoped query in
 * the app is keyed on `organizations.id` and a Clerk organization ID would not
 * satisfy those foreign keys.
 *
 * The exported shape is deliberately unchanged from the pre-Clerk version, so
 * the sixteen pages calling `requireOrg()` did not have to be touched.
 */
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
};

export type SessionOrg = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
};

export type Session = {
  /** Clerk's session ID. Opaque here; useful for correlating with Clerk's logs. */
  id: string;
  user: SessionUser;
  org: SessionOrg | null;
};

/**
 * The local row is keyed by Clerk's user ID rather than matched on email, so
 * the common path is a single indexed primary-key lookup with no call out to
 * Clerk. `currentUser()` is only reached on the very first request after
 * sign-up, when there is nothing to read yet.
 */
async function resolveUser(clerkUserId: string): Promise<SessionUser | null> {
  const existing = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      emailVerified: users.emailVerified,
      mfaEnabled: users.mfaEnabled,
    })
    .from(users)
    .where(eq(users.id, clerkUserId))
    .limit(1);

  if (existing[0]) return existing[0];

  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || clerkUser.username || email;

  const inserted = await db
    .insert(users)
    .values({
      id: clerkUserId,
      name,
      email,
      image: clerkUser.imageUrl ?? null,
      // Clerk will not issue a session for an unverified primary email, and it
      // owns MFA entirely -- these columns are now mirrors, not sources.
      emailVerified: true,
      mfaEnabled: false,
    })
    // A second concurrent request during first sign-in must not 23505.
    .onConflictDoUpdate({
      target: users.id,
      set: { name, email, image: clerkUser.imageUrl ?? null, updatedAt: new Date() },
    })
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      emailVerified: users.emailVerified,
      mfaEnabled: users.mfaEnabled,
    });

  return inserted[0] ?? null;
}

/**
 * Which organization the user is currently looking at.
 *
 * This used to live on `sessions.active_organization_id`. Clerk has no concept
 * of *our* tenants, and its own Organizations primitive would not satisfy the
 * `organization_id` foreign keys on monitors, status pages and SLOs -- so the
 * selection moves to a cookie. It is a UI preference, not a permission: every
 * read is still filtered by an actual `members` row, so forging this cookie
 * gets you nothing but your own first membership.
 */
export const ACTIVE_ORG_COOKIE = "sentinel_active_org";

export async function setActiveOrg(organizationId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

async function membershipFor(userId: string): Promise<SessionOrg | null> {
  const base = db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
      role: members.role,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId));

  const jar = await cookies();
  const preferred = jar.get(ACTIVE_ORG_COOKIE)?.value;
  if (preferred) {
    const scoped = await base
      .where(and(eq(members.userId, userId), eq(members.organizationId, preferred)))
      .limit(1);
    if (scoped[0]) return scoped[0];
  }

  // Falls back to any membership: a user invited to an org after their cookie
  // was set would otherwise stare at an empty dashboard.
  const any = await base.where(eq(members.userId, userId)).limit(1);
  return any[0] ?? null;
}

/**
 * Gives a brand-new Clerk user somewhere to land.
 *
 * Single-tenant prototype behaviour: if exactly one organization exists, the
 * user joins it, which is what puts the seeded monitors on their dashboard
 * instead of an empty shell. With zero or several organizations that guess
 * would be wrong -- joining an arbitrary existing tenant is a data leak -- so
 * they get their own instead.
 */
async function ensureMembership(user: SessionUser): Promise<SessionOrg | null> {
  const existing = await membershipFor(user.id);
  if (existing) return existing;

  const allOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .limit(2);

  let organizationId: string;
  let role: string;

  const soleOrg = allOrgs.length === 1 ? allOrgs[0] : undefined;
  if (soleOrg) {
    organizationId = soleOrg.id;
    role = "admin";
  } else {
    organizationId = generateId();
    const base = (user.email.split("@")[0] ?? "team").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await db.insert(organizations).values({
      id: organizationId,
      name: `${user.name}'s team`,
      // The slug is the public status-page URL, so it has to be unique even
      // when two people sign up with the same local-part at different domains.
      slug: `${base}-${organizationId.slice(0, 6)}`.toLowerCase(),
    });
    role = "owner";
  }

  await db
    .insert(members)
    .values({ id: generateId(), organizationId, userId: user.id, role })
    .onConflictDoNothing({ target: [members.organizationId, members.userId] });

  return membershipFor(user.id);
}

export async function getSession(): Promise<Session | null> {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) return null;

  const user = await resolveUser(userId);
  if (!user) return null;

  return { id: sessionId, user, org: await ensureMembership(user) };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  // Clerk enforces MFA and email verification before it issues a session, so
  // the old /mfa-challenge and /verify-email detours no longer exist.
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Every dashboard query is scoped by organizationId. Returning it from one
 * choke point means no page can accidentally query across tenants.
 */
export async function requireOrg(): Promise<Session & { org: SessionOrg }> {
  const session = await requireSession();
  if (!session.org) redirect("/sign-in");
  return session as Session & { org: SessionOrg };
}

/**
 * Kept because the team page lets an owner move between organizations. Clerk
 * holds no opinion about which local tenant is active, so this validates the
 * membership and the caller re-reads the session afterwards.
 */
export async function assertMembership(userId: string, organizationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
    .limit(1);
  return rows.length > 0;
}

/** Retained for callers that only need a count; avoids selecting whole rows. */
export async function membershipCount(userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(eq(members.userId, userId));
  return rows[0]?.n ?? 0;
}
