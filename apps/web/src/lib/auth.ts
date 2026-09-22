import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@sentinel/db";
import { members, organizations, sessions, users } from "@sentinel/db/schema";
import { getServerEnv } from "@sentinel/shared/env";
import { generateId, generateSessionToken } from "@sentinel/shared/server";

export const SESSION_COOKIE = "sentinel_session";

/**
 * Bumping `last_active_at` on every render would make the session row the
 * hottest write in the database for no gain — the idle window is measured in
 * minutes, so a minute of staleness cannot change the decision.
 */
const LAST_ACTIVE_WRITE_THRESHOLD_MS = 60_000;

/**
 * Sessions are opaque random tokens stored server-side, not signed JWTs.
 *
 * A JWT cannot be revoked without a denylist, which is a session table wearing
 * a hat. Since every authenticated request already touches Postgres for the
 * dashboard data, the lookup is free in practice and logout / "sign out
 * everywhere" / plan changes take effect immediately.
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
  id: string;
  token: string;
  expiresAt: Date;
  /** True while an enrolled user still owes a second factor for this session. */
  mfaPending: boolean;
  user: SessionUser;
  org: SessionOrg | null;
};

function absoluteTtlMs(): number {
  return getServerEnv().SESSION_ABSOLUTE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  } as const;
}

export async function createSession(userId: string, organizationId: string | null): Promise<string> {
  const [account] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const token = generateSessionToken();
  const now = new Date();
  const hdrs = await headers();
  const ttlMs = absoluteTtlMs();

  await db.insert(sessions).values({
    id: generateId("ses"),
    token,
    userId,
    activeOrganizationId: organizationId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    // An enrolled user's session is born half-authenticated; the challenge
    // stamps this column and nothing else does.
    mfaVerifiedAt: account?.mfaEnabled ? null : now,
    ipAddress: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(ttlMs / 1000));

  return token;
}

function isIdle(lastActiveAt: Date, nowMs: number): boolean {
  const minutes = getServerEnv().SESSION_IDLE_TIMEOUT_MINUTES;
  if (minutes === 0) return false;
  return nowMs - lastActiveAt.getTime() > minutes * 60 * 1000;
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      id: sessions.id,
      token: sessions.token,
      expiresAt: sessions.expiresAt,
      lastActiveAt: sessions.lastActiveAt,
      mfaVerifiedAt: sessions.mfaVerifiedAt,
      activeOrganizationId: sessions.activeOrganizationId,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
      userEmailVerified: users.emailVerified,
      userMfaEnabled: users.mfaEnabled,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() < now || isIdle(row.lastActiveAt, now)) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }

  if (now - row.lastActiveAt.getTime() > LAST_ACTIVE_WRITE_THRESHOLD_MS) {
    await db.update(sessions).set({ lastActiveAt: new Date(now) }).where(eq(sessions.token, token));
  }

  const org = await resolveOrg(row.userId, row.activeOrganizationId);

  return {
    id: row.id,
    token: row.token,
    expiresAt: row.expiresAt,
    mfaPending: row.userMfaEnabled && row.mfaVerifiedAt === null,
    user: {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
      image: row.userImage,
      emailVerified: row.userEmailVerified,
      mfaEnabled: row.userMfaEnabled,
    },
    org,
  };
}

/**
 * Falls back to the user's first membership when the session has no active org.
 * A user who was invited to an org after their session was created would
 * otherwise be stuck looking at an empty dashboard until they logged out.
 */
async function resolveOrg(userId: string, activeOrganizationId: string | null): Promise<SessionOrg | null> {
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

  if (activeOrganizationId) {
    const scoped = await base
      .where(and(eq(members.userId, userId), eq(members.organizationId, activeOrganizationId)))
      .limit(1);
    if (scoped[0]) return scoped[0];
  }

  const any = await base.where(eq(members.userId, userId)).limit(1);
  return any[0] ?? null;
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mfaPending) redirect("/mfa-challenge");
  if (getServerEnv().REQUIRE_EMAIL_VERIFICATION && !session.user.emailVerified) redirect("/verify-email");
  return session;
}

/**
 * Every dashboard query is scoped by organizationId. Returning it from one
 * choke point means no page can accidentally query across tenants.
 */
export async function requireOrg(): Promise<Session & { org: SessionOrg }> {
  const session = await requireSession();
  if (!session.org) redirect("/onboarding");
  return session as Session & { org: SessionOrg };
}

/**
 * Issues a new token for the same session row after a privilege change, so any
 * copy of the old token that leaked stops working. The row survives, which is
 * what keeps the device and `last_active_at` on the active-sessions list intact.
 */
export async function rotateSession(): Promise<string | null> {
  const jar = await cookies();
  const current = jar.get(SESSION_COOKIE)?.value;
  if (!current) return null;

  const token = generateSessionToken();
  const now = new Date();
  const ttlMs = absoluteTtlMs();

  const rotated = await db
    .update(sessions)
    .set({ token, updatedAt: now, lastActiveAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessions.token, current))
    .returning({ id: sessions.id });
  if (rotated.length === 0) return null;

  jar.set(SESSION_COOKIE, token, cookieOptions(ttlMs / 1000));
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.token, token));
  jar.delete(SESSION_COOKIE);
}
