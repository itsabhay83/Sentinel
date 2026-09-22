import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MfaChallengeForm } from "@/components/mfa-forms";
import { getSession } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";

export const metadata: Metadata = { title: "Two-factor authentication" };
export const dynamic = "force-dynamic";

/**
 * Reads the session directly instead of `requireSession()`, which redirects
 * half-authenticated sessions here and would therefore loop.
 */
export default async function MfaChallengePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mfaPending) redirect("/dashboard");

  return <MfaChallengeForm csrf={<CsrfInput />} />;
}
