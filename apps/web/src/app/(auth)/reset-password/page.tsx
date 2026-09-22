import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/password-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { CsrfInput } from "@/lib/csrf";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>That link is incomplete</CardTitle>
          <CardDescription>Reset links carry a token that this one is missing.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-3">
            <Link href="/forgot-password" className="text-accent transition-colors hover:text-ink">
              Request a new link
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return <ResetPasswordForm csrf={<CsrfInput />} token={token} />;
}
