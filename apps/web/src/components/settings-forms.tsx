"use client";

import type { ReactNode } from "react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { ALERT_CHANNEL_KINDS } from "@sentinel/shared";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { createChannelAction } from "@/lib/actions/channels";
import { createStatusPageAction, setStatusPagePasswordAction } from "@/lib/actions/status-pages";

export function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

function InlineSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

export function ChannelForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(createChannelAction, undefined);
  const [kind, setKind] = useState<string>("email");

  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle>Add a channel</CardTitle>
        <CardDescription>Webhook payloads are HMAC-signed when you supply a secret.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">Channel added.</Alert>}
          <Field label="Name" htmlFor="channel-name">
            <Input id="channel-name" name="name" required placeholder="On-call email" />
          </Field>
          <Field label="Kind" htmlFor="channel-kind">
            <Select id="channel-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {ALERT_CHANNEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "email" ? (
            <Field label="Destination" htmlFor="channel-to">
              <Input id="channel-to" name="to" type="email" required placeholder="oncall@company.com" />
            </Field>
          ) : (
            <>
              <Field label="Webhook URL" htmlFor="channel-url">
                <Input id="channel-url" name="url" type="url" required placeholder="https://hooks.slack.com/services/…" className="font-mono text-xs" />
              </Field>
              {kind === "webhook" && (
                <Field label="Signing secret" htmlFor="channel-secret" hint="Optional. Signs the body with HMAC-SHA256.">
                  <Input id="channel-secret" name="secret" className="font-mono text-xs" placeholder="whsec_…" />
                </Field>
              )}
            </>
          )}
          <Submit label="Add channel" />
        </form>
      </CardContent>
    </Card>
  );
}

export function StatusPageForm({ csrf, monitors }: { csrf: ReactNode; monitors: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(createStatusPageAction, undefined);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>New status page</CardTitle>
        <CardDescription>Public and unauthenticated. Internal names and URLs are never exposed.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">Status page created.</Alert>}
          <Field label="Title" htmlFor="sp-title">
            <Input id="sp-title" name="title" required placeholder="Acme Rockets Status" />
          </Field>
          <Field label="Slug" htmlFor="sp-slug" hint="Reachable at /status/<slug>">
            <Input id="sp-slug" name="slug" required placeholder="acme" />
          </Field>
          <Field label="Description" htmlFor="sp-description">
            <Input id="sp-description" name="description" placeholder="Live availability for our public services." />
          </Field>
          <Field label="Uptime window (days)" htmlFor="sp-days">
            <Input id="sp-days" name="showUptimeDays" type="number" min={7} max={365} defaultValue={90} />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm text-ink-2">Monitors</legend>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2/40 p-2">
              {monitors.map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-ink-2 hover:bg-surface-3">
                  <input type="checkbox" name="monitorIds" value={m.id} className="size-3.5 accent-[--color-accent]" />
                  <span className="truncate">{m.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="published" defaultChecked className="size-4 accent-[--color-accent]" />
            Publish immediately
          </label>
          <Submit label="Create status page" />
        </form>
      </CardContent>
    </Card>
  );
}

export function StatusPagePassword({ csrf, pageId, isProtected }: { csrf: ReactNode; pageId: string; isProtected: boolean }) {
  const [state, formAction] = useActionState(setStatusPagePasswordAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {isProtected ? "Change password" : "Protect"}
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex basis-full flex-wrap items-center gap-2">
      {csrf}
      <input type="hidden" name="pageId" value={pageId} />
      <Input
        name="password"
        type="password"
        autoComplete="new-password"
        className="h-8 flex-1 basis-56 text-xs"
        placeholder={isProtected ? "New password — leave blank to make public" : "Password (8+ characters)"}
      />
      <InlineSubmit label="Save" />
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {state?.error && (
        <Alert tone="danger" className="basis-full">
          {state.error}
        </Alert>
      )}
      {state?.ok && (
        <Alert tone="accent" className="basis-full">
          Saved. Existing visitors must re-enter the password.
        </Alert>
      )}
    </form>
  );
}
