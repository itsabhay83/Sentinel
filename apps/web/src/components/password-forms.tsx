"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { changePasswordAction, requestPasswordResetAction, resetPasswordAction } from "@/lib/actions/password";
import { resendVerificationAction } from "@/lib/actions/verification";

function SubmitButton({ idle, busy, wide = true }: { idle: string; busy: string; wide?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size={wide ? "lg" : "md"} className={wide ? "w-full" : undefined} disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

export function ForgotPasswordForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(requestPasswordResetAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>We will email you a single-use link.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">If that address has an account, a reset link is on its way.</Alert>}
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
          </Field>
          <SubmitButton idle="Send reset link" busy="Sending…" />
        </form>
        <p className="mt-5 text-center text-sm text-ink-3">
          <Link href="/login" className="text-accent transition-colors hover:text-ink">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function ResetPasswordForm({ csrf, token }: { csrf: ReactNode; token: string }) {
  const [state, formAction] = useActionState(resetPasswordAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>Every signed-in device will be signed out.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          <input type="hidden" name="token" value={token} />
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="New password" htmlFor="password" hint="At least 8 characters.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} autoFocus />
          </Field>
          <SubmitButton idle="Set new password" busy="Saving…" />
        </form>
      </CardContent>
    </Card>
  );
}

export function ResendVerificationForm({ csrf, email }: { csrf: ReactNode; email: string }) {
  const [state, formAction] = useActionState(resendVerificationAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {csrf}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Sent. Check your inbox — the link expires.</Alert>}
      <Field label="Email" htmlFor="verify-email">
        <Input id="verify-email" name="email" type="email" autoComplete="email" required defaultValue={email} />
      </Field>
      <SubmitButton idle="Resend verification email" busy="Sending…" />
    </form>
  );
}

export function ChangePasswordForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(changePasswordAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">Password changed. Your other sessions were signed out.</Alert>}
          <Field label="Current password" htmlFor="currentPassword">
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="New password" htmlFor="new-password" hint="At least 8 characters.">
            <Input id="new-password" name="password" type="password" autoComplete="new-password" required minLength={8} />
          </Field>
          <SubmitButton idle="Change password" busy="Saving…" wide={false} />
        </form>
      </CardContent>
    </Card>
  );
}
