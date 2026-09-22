import "server-only";

import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "@sentinel/db";
import { sessions } from "@sentinel/db/schema";

/**
 * The set of sessions belonging to a user, as opposed to `auth.ts` which owns
 * the one session the current request arrived with. Every function here is
 * scoped by `userId` so a forged session id can only ever revoke your own.
 */
export type SessionRecord = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: Date;
  createdAt: Date;
  expiresAt: Date;
};

export async function listUserSessions(userId: string): Promise<SessionRecord[]> {
  return db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      lastActiveAt: sessions.lastActiveAt,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastActiveAt));
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id });
  return deleted.length;
}

/** Password reset signs the account out everywhere, including the tab doing the reset. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function markSessionMfaVerified(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ mfaVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/**
 * Enrolling or disabling MFA changes what a session is allowed to do, so every
 * other session has to re-satisfy the new rule rather than inherit the old one.
 */
export async function clearMfaVerification(userId: string, exceptSessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ mfaVerifiedAt: null, updatedAt: new Date() })
    .where(and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)));
}
