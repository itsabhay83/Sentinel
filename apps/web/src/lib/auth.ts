import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";

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
  /**
   * Clerk's user ID. Distinct from `user.id`, which is the local primary key
   * every foreign key points at -- passing the wrong one to Clerk's API would
   * address a different account, or none.
   */
  clerkUserId: string;
  user: SessionUser;
  org: SessionOrg | null;
};

const USER_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  image: users.image,
  emailVerified: users.emailVerified,
  mfaEnabled: users.mfaEnabled,
} as const;

/**
 * Maps a Clerk user onto a local `users` row, claiming a pre-Clerk account when
 * one already exists for the same address.
 *
 * The claim step is not optional. This app had real accounts before Clerk, and
 * those rows own organizations, audit entries and invitations. Inserting a
 * second row for the same person would have collided with `users_email_unique`
 * anyway -- which is exactly how this surfaced -- and re-keying the old row to
 * Clerk's ID is impossible, because none of the eight foreign keys pointing at
 * `users.id` declares ON UPDATE CASCADE. So the Clerk ID is recorded alongside
 * the existing row and `users.id` never moves.
 */
async function resolveUser(clerkUserId: string): Promise<SessionUser | null> {
  const linked = await db.select(USER_COLUMNS).from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  if (linked[0]) return linked[0];

  // Only reached once per account: the first sign-in after the cutover.
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || clerkUser.username || email;
  const image = clerkUser.imageUrl ?? null;

  // Claim by email. Safe because Clerk will not issue a session for an email it
  // has not verified, so possession of the address is already proven.
  const claimed = await db
    .update(users)
    .set({ clerkUserId, name, image, emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.email, email), isNull(users.clerkUserId)))
    .returning(USER_COLUMNS);
  if (claimed[0]) return claimed[0];

  const created = await db
    .insert(users)
    .values({
      id: generateId("usr"),
      clerkUserId,
      name,
      email,
      image,
      // Clerk owns verification and MFA now; these columns are mirrors.
      emailVerified: true,
      mfaEnabled: false,
    })
    // Two concurrent first requests must not race into a 23505.
    .onConflictDoNothing()
    .returning(USER_COLUMNS);
  if (created[0]) return created[0];

  const raced = await db.select(USER_COLUMNS).from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  return raced[0] ?? null;
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

  return { id: sessionId, clerkUserId: userId, user, org: await ensureMembership(user) };
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
