"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Lock, MailCheck } from "lucide-react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { unlockStatusPageAction } from "@/lib/actions/status-page";
import { subscribeToStatusPageAction } from "@/lib/actions/subscribe";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Checking…" : "View status"}
    </Button>
  );
}

export function StatusPageLock({ slug, title, accent }: { slug: string; title: string; accent: string }) {
  const [state, formAction] = useActionState(unlockStatusPageAction, undefined);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <div className="rounded-xl border border-line bg-surface/60 p-6">
        <span
          className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2"
          style={{ color: accent }}
        >
          <Lock className="size-4" />
        </span>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-ink-2">This status page is private. Enter the password you were given to continue.</p>

        <form action={formAction} className="mt-5 space-y-4">
          <input type="hidden" name="slug" value={slug} />
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Password" htmlFor="status-password">
            <Input id="status-password" name="password" type="password" autoComplete="current-password" autoFocus required />
          </Field>
          <Submit />
        </form>
      </div>
      <p className="mt-6 text-center text-xs text-ink-3">
        Monitored from multiple regions by <span className="text-ink-2">Sentinel</span>
      </p>
    </main>
  );
}

function SubscribeSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" size="sm" disabled={pending}>
      {pending ? "Sending…" : "Subscribe"}
    </Button>
  );
}

export function SubscribeForm({ slug, accent }: { slug: string; accent: string }) {
  const [state, formAction] = useActionState(subscribeToStatusPageAction, undefined);

  if (state?.ok) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3 text-sm text-ink-2">
        <MailCheck className="size-4 shrink-0" style={{ color: accent }} />
        Check your inbox — open the confirmation link to start receiving updates.
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <Input
        name="email"
        type="email"
        required
        placeholder="you@company.com"
        aria-label="Email address"
        className="h-9 flex-1 basis-56"
      />
      <SubscribeSubmit />
      {state?.error && (
        <Alert tone="danger" className="basis-full">
          {state.error}
        </Alert>
      )}
    </form>
  );
}
