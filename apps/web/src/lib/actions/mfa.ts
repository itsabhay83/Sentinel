"use server";

/**
 * TOTP enrolment and removal. Both require a fully authenticated session, which
 * is what separates them from the challenge in `mfa-challenge.ts`.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@sentinel/db";
import { accounts, userMfaFactors, userRecoveryCodes, users } from "@sentinel/db/schema";
import { hashToken, verifyPassword } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { assertCsrf } from "@/lib/csrf";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "@/lib/mfa";
import { clearMfaVerification, markSessionMfaVerified } from "@/lib/sessions";

export type MfaState =
  | { error?: string; ok?: boolean; secret?: string; otpauth?: string; recoveryCodes?: string[] }
  | undefined;

const codeSchema = z.object({ code: z.string().trim().min(6, "Enter the 6-digit code").max(10) });
const passwordSchema = z.object({ password: z.string().min(1, "Enter your password") });

/**
 * Writes the secret with `confirmed_at` still null. Until the user proves a
 * working code the factor is inert, so a half-finished enrolment — the phone
 * ran out of battery mid-scan — can never lock anyone out.
 */
export async function startMfaEnrollmentAction(_prev: MfaState, formData: FormData): Promise<MfaState> {
  await assertCsrf(formData);

  const session = await requireSession();
  if (session.user.mfaEnabled) return { error: "Two-factor authentication is already enabled." };

  const secret = generateTotpSecret();
  const now = new Date();
  await db
    .insert(userMfaFactors)
    .values({ userId: session.user.id, type: "totp", secretEncrypted: encryptMfaSecret(secret), createdAt: now })
    .onConflictDoUpdate({
      target: [userMfaFactors.userId, userMfaFactors.type],
      set: { secretEncrypted: encryptMfaSecret(secret), confirmedAt: null, createdAt: now },
    });

  return { secret, otpauth: otpauthUri(session.user.email, secret) };
}

export async function confirmMfaEnrollmentAction(_prev: MfaState, formData: FormData): Promise<MfaState> {
  await assertCsrf(formData);

  const session = await requireSession();
  const parsed = codeSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const [factor] = await db
    .select({ secretEncrypted: userMfaFactors.secretEncrypted })
    .from(userMfaFactors)
    .where(and(eq(userMfaFactors.userId, session.user.id), eq(userMfaFactors.type, "totp")))
    .limit(1);
  if (!factor) return { error: "Start the setup again — there is no pending authenticator." };

  if (!verifyTotp(decryptMfaSecret(factor.secretEncrypted), parsed.data.code)) {
    await recordAudit({
      action: "auth.mfa.challenge.failed",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      metadata: { stage: "enrollment" },
    });
    return { error: "That code did not match. Check your authenticator and try again." };
  }

  const now = new Date();
  const recoveryCodes = generateRecoveryCodes();

  await db.transaction(async (tx) => {
    await tx
      .update(userMfaFactors)
      .set({ confirmedAt: now, lastUsedAt: now })
      .where(and(eq(userMfaFactors.userId, session.user.id), eq(userMfaFactors.type, "totp")));
    await tx.update(users).set({ mfaEnabled: true, updatedAt: now }).where(eq(users.id, session.user.id));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, session.user.id));
    await tx.insert(userRecoveryCodes).values(
      recoveryCodes.map((code) => ({ userId: session.user.id, codeHash: hashToken(code), createdAt: now })),
    );
  });

  await markSessionMfaVerified(session.id);
  await clearMfaVerification(session.user.id, session.id);
  await recordAudit({
    action: "auth.mfa.enrolled",
    organizationId: session.org?.id ?? null,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
  });

  return { ok: true, recoveryCodes };
}

/**
 * Requires the password again: an unattended logged-in laptop is exactly the
 * threat the second factor exists for, so it must not be removable from one.
 */
export async function disableMfaAction(_prev: MfaState, formData: FormData): Promise<MfaState> {
  await assertCsrf(formData);

  const session = await requireSession();
  const parsed = passwordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const [credential] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, session.user.id), eq(accounts.providerId, "credential")))
    .limit(1);

  const stored = credential?.password;
  if (!stored || !(await verifyPassword(parsed.data.password, stored))) {
    return { error: "That is not your current password." };
  }

  await db.transaction(async (tx) => {
    await tx.delete(userMfaFactors).where(eq(userMfaFactors.userId, session.user.id));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, session.user.id));
    await tx.update(users).set({ mfaEnabled: false, updatedAt: new Date() }).where(eq(users.id, session.user.id));
  });

  await recordAudit({
    action: "auth.mfa.disabled",
    organizationId: session.org?.id ?? null,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
  });

  return { ok: true };
}
