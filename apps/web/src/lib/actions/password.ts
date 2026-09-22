"use server";

/**
 * Password reset and password change.
 *
 * Split out of `auth.ts` because the reset half is reachable without a session
 * and the change half requires one — two different trust boundaries that would
 * otherwise sit in the same file and be easy to confuse when editing.
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@sentinel/db";
import { accounts, users } from "@sentinel/db/schema";
import { getServerEnv } from "@sentinel/shared/env";
import { hashPassword, verifyPassword } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { requireSession, rotateSession } from "@/lib/auth";
import { assertCsrf } from "@/lib/csrf";
import { rateLimited } from "@/lib/form-state";
import { appUrl, sendMail } from "@/lib/mail";
import { checkCredentialRateLimit } from "@/lib/ratelimit";
import { revokeAllSessions, revokeOtherSessions } from "@/lib/sessions";
import { consumeVerificationToken, issueVerificationToken } from "@/lib/verification";

export type ActionState = { error?: string; ok?: boolean } | undefined;

const passwordField = z.string().min(8, "Password must be at least 8 characters").max(200);

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

/**
 * Answers identically whether or not the address has an account. Telling the
 * difference here would turn the reset form into the account-enumeration oracle
 * that `loginAction` deliberately refuses to be.
 */
export async function requestPasswordResetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const parsed = requestSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { email } = parsed.data;

  const limit = await checkCredentialRateLimit("passwordReset", email);
  if (!limit.allowed) return rateLimited(limit);

  const env = getServerEnv();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  if (user) {
    const token = await issueVerificationToken(email, "password_reset", env.PASSWORD_RESET_TTL_MINUTES);
    await sendMail({
      to: email,
      subject: "Reset your Sentinel password",
      text: `Use this link to choose a new password:\n\n${appUrl(`/reset-password?token=${encodeURIComponent(token)}`)}\n\nThe link expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes and can be used once. If you did not ask for this, ignore it.`,
    });
    await recordAudit({
      action: "auth.password.reset.requested",
      actorUserId: user.id,
      actorEmail: email,
      targetType: "user",
      targetId: user.id,
    });
  }

  return { ok: true };
}

const resetSchema = z.object({
  token: z.string().trim().min(1, "The reset link is missing its token"),
  password: passwordField,
});

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const parsed = resetSchema.safeParse({ token: formData.get("token"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const email = await consumeVerificationToken(parsed.data.token, "password_reset");
  if (!email) return { error: "That reset link has expired or has already been used." };

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) return { error: "That reset link has expired or has already been used." };

  await db
    .update(accounts)
    .set({ password: await hashPassword(parsed.data.password), updatedAt: new Date() })
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")));

  // Whoever forced the reset may be sitting on a stolen session, so every
  // session dies — including the one that requested the reset.
  await revokeAllSessions(user.id);
  await recordAudit({
    action: "auth.password.reset.completed",
    actorUserId: user.id,
    actorEmail: email,
    targetType: "user",
    targetId: user.id,
  });

  redirect("/login");
}

const changeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  password: passwordField,
});

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const session = await requireSession();
  const parsed = changeSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const [credential] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, session.user.id), eq(accounts.providerId, "credential")))
    .limit(1);

  const current = credential?.password;
  if (!current || !(await verifyPassword(parsed.data.currentPassword, current))) {
    return { error: "That is not your current password." };
  }

  await db
    .update(accounts)
    .set({ password: await hashPassword(parsed.data.password), updatedAt: new Date() })
    .where(and(eq(accounts.userId, session.user.id), eq(accounts.providerId, "credential")));

  await revokeOtherSessions(session.user.id, session.id);
  await rotateSession();
  await recordAudit({
    action: "auth.password.changed",
    organizationId: session.org?.id ?? null,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
  });

  return { ok: true };
}
