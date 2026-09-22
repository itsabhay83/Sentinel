"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { confirmMfaEnrollmentAction, disableMfaAction, startMfaEnrollmentAction } from "@/lib/actions/mfa";
import { verifyMfaChallengeAction } from "@/lib/actions/mfa-challenge";

function SubmitButton({ idle, busy, wide = true }: { idle: string; busy: string; wide?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size={wide ? "lg" : "md"} className={wide ? "w-full" : undefined} disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

export function MfaChallengeForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(verifyMfaChallengeAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>Enter the code from your authenticator, or one of your recovery codes.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Code" htmlFor="code">
            <Input id="code" name="code" inputMode="text" autoComplete="one-time-code" required autoFocus className="font-mono tracking-widest" placeholder="123456" />
          </Field>
          <SubmitButton idle="Verify" busy="Verifying…" />
        </form>
      </CardContent>
    </Card>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert tone="accent">
      <span className="block text-xs">Store these now — each works once and they are never shown again.</span>
      <span className="mt-2 grid grid-cols-2 gap-1 font-mono text-[11px] text-ink">
        {codes.map((code) => (
          <code key={code} className="rounded bg-canvas/60 px-2 py-1">
            {code}
          </code>
        ))}
      </span>
    </Alert>
  );
}

function EnrollmentSetup({ csrf }: { csrf: ReactNode }) {
  const [start, startAction] = useActionState(startMfaEnrollmentAction, undefined);
  const [confirm, confirmAction] = useActionState(confirmMfaEnrollmentAction, undefined);

  if (confirm?.recoveryCodes) return <RecoveryCodes codes={confirm.recoveryCodes} />;

  if (!start?.otpauth || !start.secret) {
    return (
      <form action={startAction} className="space-y-3">
        {csrf}
        {start?.error && <Alert tone="danger">{start.error}</Alert>}
        <p className="text-sm text-ink-2">Protect sign-in with a time-based code from an authenticator app.</p>
        <SubmitButton idle="Set up authenticator" busy="Generating…" wide={false} />
      </form>
    );
  }

  return (
    <form action={confirmAction} className="space-y-4">
      {csrf}
      {confirm?.error && <Alert tone="danger">{confirm.error}</Alert>}
      <Field label="Setup URI" hint="Paste into your authenticator app, or add the key below by hand.">
        <code className="block select-all break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-2">
          {start.otpauth}
        </code>
      </Field>
      <Field label="Manual entry key">
        <code className="block select-all break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs tracking-wider text-ink">
          {start.secret}
        </code>
      </Field>
      <Field label="Code from your app" htmlFor="mfa-code">
        <Input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" required className="font-mono tracking-widest" placeholder="123456" />
      </Field>
      <SubmitButton idle="Confirm and enable" busy="Verifying…" wide={false} />
    </form>
  );
}

function DisableForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(disableMfaAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {csrf}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Two-factor authentication is off.</Alert>}
      <p className="text-sm text-ink-2">Two-factor authentication is on. Removing it needs your password.</p>
      <Field label="Password" htmlFor="mfa-password">
        <Input id="mfa-password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton idle="Turn off two-factor" busy="Saving…" wide={false} />
    </form>
  );
}

export function MfaCard({ csrf, enabled }: { csrf: ReactNode; enabled: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
      </CardHeader>
      <CardContent>{enabled ? <DisableForm csrf={csrf} /> : <EnrollmentSetup csrf={csrf} />}</CardContent>
    </Card>
  );
}
