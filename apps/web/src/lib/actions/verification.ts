"use server";

/**
 * Re-sending the email verification link. Answers identically for an unknown
 * address, an already-verified one and a fresh send, for the same
 * anti-enumeration reason the password-reset request does.
 */
import { eq } from "drizzle-orm";
import { db } from "@sentinel/db";
import { users } from "@sentinel/db/schema";
import { z } from "zod";
import { assertCsrf } from "@/lib/csrf";
import { rateLimited } from "@/lib/form-state";
import { checkCredentialRateLimit } from "@/lib/ratelimit";
import { sendEmailVerification } from "@/lib/verification";

export type ActionState = { error?: string; ok?: boolean } | undefined;

const resendSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export async function resendVerificationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const parsed = resendSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { email } = parsed.data;

  const limit = await checkCredentialRateLimit("emailVerification", email);
  if (!limit.allowed) return rateLimited(limit);

  const [user] = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user && !user.emailVerified) await sendEmailVerification(email, user.id);

  return { ok: true };
}
