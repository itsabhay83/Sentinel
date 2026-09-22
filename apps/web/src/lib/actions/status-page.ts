"use server";

import { redirect } from "next/navigation";
import { verifyPassword } from "@sentinel/shared/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { getStatusPageAccess } from "@/lib/queries";
import { checkIpRateLimit, retryAfterMessage } from "@/lib/ratelimit";
import { issueStatusPageGrant } from "@/lib/status-gate";
import type { ActionState } from "@/lib/actions/settings";

const unlockSchema = z.object({
  slug: z.string().min(1),
  password: z.string().min(1, "Enter the page password"),
});

/**
 * Unauthenticated by design — this is the door, not something behind it.
 *
 * Every failure returns the same message whether the page is public, missing or
 * the password is simply wrong, so the form cannot be used to enumerate which
 * status pages exist or which of them are protected. The scrypt verify itself
 * (N=32768) is the brake on guessing, and the IP budget below is the brake on
 * turning that cost into a denial of service against our own CPU.
 */
export async function unlockStatusPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // Origin only, no double-submit token: the visitor at this gate is anonymous,
  // so there is no guarantee a CSRF cookie was ever minted for them.
  await assertSameOrigin();

  const rate = await checkIpRateLimit("statusGate");
  if (!rate.allowed) return { error: retryAfterMessage(rate) };

  const parsed = unlockSchema.safeParse({ slug: formData.get("slug"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const page = await getStatusPageAccess(parsed.data.slug);
  if (!page || page.passwordHash === null || !(await verifyPassword(parsed.data.password, page.passwordHash))) {
    return { error: "Incorrect password" };
  }

  await issueStatusPageGrant(page.id, page.passwordHash);
  redirect(`/status/${parsed.data.slug}`);
}
