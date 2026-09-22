"use server";

/**
 * The second-factor gate. Reachable by a session that exists but is not yet
 * usable, which is why it calls `getSession()` rather than `requireSession()` —
 * the latter would bounce it straight back to the challenge page.
 */
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@sentinel/db";
import { userMfaFactors, userRecoveryCodes } from "@sentinel/db/schema";
import { hashToken } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { getSession } from "@/lib/auth";
import { assertCsrf } from "@/lib/csrf";
import { rateLimited } from "@/lib/form-state";
import { takeInvite } from "@/lib/invite-cookie";
import { decryptMfaSecret, normaliseRecoveryCode, verifyTotp } from "@/lib/mfa";
import { checkCredentialRateLimit } from "@/lib/ratelimit";
import { markSessionMfaVerified } from "@/lib/sessions";

export type ChallengeState = { error?: string } | undefined;

const challengeSchema = z.object({ code: z.string().trim().min(6, "Enter your code").max(20) });

/**
 * Burns the code in the same statement that requires it to be unused, so a
 * replay of a recovery code cannot win a race against its own first use.
 */
async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const used = await db
    .update(userRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        eq(userRecoveryCodes.codeHash, hashToken(normaliseRecoveryCode(code))),
        isNull(userRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: userRecoveryCodes.id });
  return used.length > 0;
}

export async function verifyMfaChallengeAction(_prev: ChallengeState, formData: FormData): Promise<ChallengeState> {
  await assertCsrf(formData);

  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mfaPending) redirect("/dashboard");

  const parsed = challengeSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const limit = await checkCredentialRateLimit("mfaVerify", session.user.id);
  if (!limit.allowed) return rateLimited(limit);

  const [factor] = await db
    .select({ secretEncrypted: userMfaFactors.secretEncrypted })
    .from(userMfaFactors)
    .where(and(eq(userMfaFactors.userId, session.user.id), eq(userMfaFactors.type, "totp")))
    .limit(1);

  const totpAccepted = factor ? verifyTotp(decryptMfaSecret(factor.secretEncrypted), parsed.data.code) : false;
  const recoveryAccepted = totpAccepted ? false : await consumeRecoveryCode(session.user.id, parsed.data.code);

  if (!totpAccepted && !recoveryAccepted) {
    await recordAudit({
      action: "auth.mfa.challenge.failed",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      metadata: { stage: "login" },
    });
    return { error: "That code is not valid." };
  }

  if (recoveryAccepted) {
    await recordAudit({
      action: "auth.mfa.recovery_code.used",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
    });
  } else {
    await db
      .update(userMfaFactors)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(userMfaFactors.userId, session.user.id), eq(userMfaFactors.type, "totp")));
  }

  await markSessionMfaVerified(session.id);

  // The invite `loginAction` stashed is still pending — it was skipped there
  // because the session was not usable yet.
  const invite = await takeInvite();
  if (invite) redirect(`/invite/${invite}`);
  redirect(session.org ? "/dashboard" : "/onboarding");
}
