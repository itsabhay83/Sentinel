import "server-only";

import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "@sentinel/db";
import { users, verifications } from "@sentinel/db/schema";
import { getServerEnv } from "@sentinel/shared/env";
import { generateId, generateToken, hashToken } from "@sentinel/shared/server";

import { recordAudit } from "@/lib/audit";
import { appUrl, sendMail } from "@/lib/mail";

/**
 * Single-use token lifecycle for password reset and email verification.
 *
 * Only the SHA-256 digest is stored, so a database read cannot be replayed as a
 * working link, and the token is never reconstructible from the row.
 */
export type VerificationPurpose = "password_reset" | "email_verification";

const TOKEN_BYTES = 32;

export async function issueVerificationToken(
  identifier: string,
  purpose: VerificationPurpose,
  ttlMinutes: number,
): Promise<string> {
  const token = generateToken(TOKEN_BYTES);
  const now = new Date();

  await db.insert(verifications).values({
    id: generateId("ver"),
    identifier,
    value: hashToken(token),
    purpose,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });

  return token;
}

/**
 * Returns the identifier the token was issued for, or null when it is unknown,
 * expired, already spent or issued for a different purpose.
 *
 * Stamping `consumed_at` inside the same statement that requires it to be null
 * is what makes the token single-use: two concurrent submissions of the same
 * link both run the UPDATE, and exactly one of them gets a row back.
 */
export async function consumeVerificationToken(
  token: string,
  purpose: VerificationPurpose,
): Promise<string | null> {
  const now = new Date();
  const consumed = await db
    .update(verifications)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(verifications.value, hashToken(token)),
        eq(verifications.purpose, purpose),
        isNull(verifications.consumedAt),
        gt(verifications.expiresAt, now),
      ),
    )
    .returning({ identifier: verifications.identifier });

  return consumed[0]?.identifier ?? null;
}

export async function sendEmailVerification(email: string, userId: string): Promise<void> {
  const env = getServerEnv();
  const token = await issueVerificationToken(email, "email_verification", env.EMAIL_VERIFICATION_TTL_MINUTES);
  const link = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);

  await sendMail({
    to: email,
    subject: "Verify your Sentinel email address",
    text: `Confirm this address to activate your Sentinel account:\n\n${link}\n\nThe link expires in ${env.EMAIL_VERIFICATION_TTL_MINUTES} minutes.`,
  });

  await recordAudit({
    action: "auth.email.verification.sent",
    actorUserId: userId,
    actorEmail: email,
    targetType: "user",
    targetId: userId,
  });
}

export async function confirmEmailVerification(token: string): Promise<boolean> {
  const email = await consumeVerificationToken(token, "email_verification");
  if (!email) return false;

  const verified = await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });

  const user = verified[0];
  if (!user) return false;

  await recordAudit({
    action: "auth.email.verified",
    actorUserId: user.id,
    actorEmail: email,
    targetType: "user",
    targetId: user.id,
  });
  return true;
}
