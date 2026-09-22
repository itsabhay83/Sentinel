"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { createOrganizationAction, loginAction, signupAction } from "@/lib/actions/auth";

/**
 * The CSRF field arrives as a rendered server component rather than a string:
 * reading the cookie is a server concern, and these forms are client components
 * so they can drive `useActionState`.
 */
function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

export function LoginForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(loginAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your Sentinel workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" defaultValue="demo@sentinel.dev" />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required defaultValue="sentinel123" />
          </Field>
          <SubmitButton idle="Sign in" busy="Signing in…" />
        </form>
        <p className="mt-5 text-center text-sm text-ink-3">
          <Link href="/forgot-password" className="text-accent transition-colors hover:text-ink">
            Forgot your password?
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-ink-3">
          No account?{" "}
          <Link href="/signup" className="text-accent transition-colors hover:text-ink">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function SignupForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(signupAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start monitoring</CardTitle>
        <CardDescription>Create your account and workspace. No credit card.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Your name" htmlFor="name">
            <Input id="name" name="name" autoComplete="name" required placeholder="Ada Lovelace" />
          </Field>
          <Field label="Work email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 8 characters.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
          </Field>
          <Field label="Organization" htmlFor="organization" hint="Shown on your status pages and alerts.">
            <Input id="organization" name="organization" required placeholder="Acme Rockets" />
          </Field>
          <SubmitButton idle="Create account" busy="Creating your workspace…" />
        </form>
        <p className="mt-5 text-center text-sm text-ink-3">
          Already have an account?{" "}
          <Link href="/login" className="text-accent transition-colors hover:text-ink">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function OrganizationForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(createOrganizationAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your organization</CardTitle>
        <CardDescription>Monitors, alert channels and status pages all live inside an organization.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Organization name" htmlFor="name">
            <Input id="name" name="name" required placeholder="Acme Rockets" autoFocus />
          </Field>
          <SubmitButton idle="Create organization" busy="Creating…" />
        </form>
      </CardContent>
    </Card>
  );
}
