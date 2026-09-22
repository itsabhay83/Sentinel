"use client";

import type { ReactNode } from "react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import {
  addEscalationStepAction,
  createEscalationPolicyAction,
  createMaintenanceWindowAction,
  setPolicyMonitorsAction,
} from "@/lib/actions/alerting";

type Option = { id: string; name: string };

function Submit({ label, full = true }: { label: string; full?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size={full ? "md" : "sm"} className={full ? "w-full" : undefined} disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

function CheckboxList({
  name,
  options,
  selected,
  empty,
}: {
  name: string;
  options: Option[];
  selected?: Set<string>;
  empty: string;
}) {
  if (options.length === 0) {
    return <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-4 text-center text-xs text-ink-3">{empty}</p>;
  }
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2/40 p-2">
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-ink-2 hover:bg-surface-3">
          <input
            type="checkbox"
            name={name}
            value={o.id}
            defaultChecked={selected?.has(o.id)}
            className="size-3.5 accent-[--color-accent]"
          />
          <span className="truncate">{o.name}</span>
        </label>
      ))}
    </div>
  );
}

export function EscalationPolicyForm({ csrf, channels }: { csrf: ReactNode; channels: Option[] }) {
  const [state, formAction] = useActionState(createEscalationPolicyAction, undefined);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>New escalation policy</CardTitle>
        <CardDescription>
          A monitor with no policy attached is never alerted on. The channels you pick here are paged the moment an
          incident opens.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">Policy created. Attach monitors to it to start alerting.</Alert>}
          <Field label="Name" htmlFor="ep-name">
            <Input id="ep-name" name="name" required placeholder="Primary on-call" />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm text-ink-2">First page goes to</legend>
            <CheckboxList name="channelIds" options={channels} empty="Add an alert channel first." />
          </fieldset>
          <Submit label="Create policy" />
        </form>
      </CardContent>
    </Card>
  );
}

export function EscalationStepForm({ csrf, policyId, channels }: { csrf: ReactNode; policyId: string; channels: Option[] }) {
  const [state, formAction] = useActionState(addEscalationStepAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Add step
      </Button>
    );
  }

  return (
    <form action={formAction} className="mt-2 space-y-2 rounded-lg border border-line bg-surface-3/40 p-2.5">
      {csrf}
      <input type="hidden" name="policyId" value={policyId} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Step added.</Alert>}
      <Field label="Escalate after (minutes)" htmlFor={`step-min-${policyId}`}>
        <Input id={`step-min-${policyId}`} name="afterMinutes" type="number" min={1} max={1440} defaultValue={15} />
      </Field>
      <CheckboxList name="channelIds" options={channels} empty="Add an alert channel first." />
      <div className="flex items-center gap-2">
        <Submit label="Add step" full={false} />
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PolicyMonitorsForm({
  csrf,
  policyId,
  monitors,
  attached,
}: {
  csrf: ReactNode;
  policyId: string;
  monitors: Option[];
  attached: string[];
}) {
  const [state, formAction] = useActionState(setPolicyMonitorsAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {attached.length === 0 ? "Attach monitors" : `${attached.length} monitors`}
      </Button>
    );
  }

  return (
    <form action={formAction} className="mt-2 space-y-2 rounded-lg border border-line bg-surface-3/40 p-2.5">
      {csrf}
      <input type="hidden" name="policyId" value={policyId} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Monitors updated.</Alert>}
      <CheckboxList name="monitorIds" options={monitors} selected={new Set(attached)} empty="No monitors yet." />
      <div className="flex items-center gap-2">
        <Submit label="Save monitors" full={false} />
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function MaintenanceForm({ csrf, monitors }: { csrf: ReactNode; monitors: Option[] }) {
  const [state, formAction] = useActionState(createMaintenanceWindowAction, undefined);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Schedule maintenance</CardTitle>
        <CardDescription>
          Checks keep running and incidents still open — only the pages are suppressed, so the history stays honest.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">Maintenance window scheduled.</Alert>}
          <Field label="Reason" htmlFor="mw-reason">
            <Input id="mw-reason" name="reason" placeholder="Database failover" />
          </Field>
          <Field label="Starts" htmlFor="mw-start">
            <Input id="mw-start" name="startsAt" type="datetime-local" required />
          </Field>
          <Field label="Ends" htmlFor="mw-end">
            <Input id="mw-end" name="endsAt" type="datetime-local" required />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm text-ink-2">Suppress alerts for</legend>
            <CheckboxList name="monitorIds" options={monitors} empty="No monitors yet." />
          </fieldset>
          <Submit label="Schedule window" />
        </form>
      </CardContent>
    </Card>
  );
}
