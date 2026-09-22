import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerificationForm } from "@/components/password-forms";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { confirmEmailVerification } from "@/lib/verification";

export const metadata: Metadata = { title: "Verify your email" };
export const dynamic = "force-dynamic";

/**
 * Doubles as the landing page for the emailed link and as the wall unverified
 * users hit when `REQUIRE_EMAIL_VERIFICATION` is on. Consuming the token during
 * a GET render is unavoidable — the link in the email is the only handle the
 * user has — but the token is single-use, so a prefetch can spend it at worst
 * once, for the person who owns the mailbox.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const verified = token ? await confirmEmailVerification(token) : false;
  const session = await getSession();

  if (verified) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email verified</CardTitle>
          <CardDescription>Your address is confirmed.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-3">
            <Link href="/dashboard" className="text-accent transition-colors hover:text-ink">
              Go to your dashboard
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>Sentinel needs a confirmed address before it can page you.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {token && <Alert tone="danger">That verification link has expired or has already been used.</Alert>}
        <ResendVerificationForm csrf={<CsrfInput />} email={session?.user.email ?? ""} />
        <p className="text-center text-sm text-ink-3">
          <Link href="/login" className="text-accent transition-colors hover:text-ink">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
