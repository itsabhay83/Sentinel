"use client";

import type { ReactNode } from "react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { saveSloAction } from "@/lib/actions/slos";
import { MAX_TARGET_PERCENT, MAX_WINDOW_DAYS, MIN_TARGET_PERCENT, MIN_WINDOW_DAYS } from "@/lib/slo";

type Candidate = { id: string; name: string; hasSlo: boolean };

function Submit({ label, full = true }: { label: string; full?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size={full ? "md" : "sm"} className={full ? "w-full" : undefined} disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

function TargetFields({ idPrefix, targetPercent, windowDays }: { idPrefix: string; targetPercent: number; windowDays: number }) {
  return (
    <>
      <Field label="Target availability (%)" htmlFor={`${idPrefix}-target`} hint="The fraction of checks that must succeed across the window.">
        <Input
          id={`${idPrefix}-target`}
          name="targetPercent"
          type="number"
          step="0.001"
          min={MIN_TARGET_PERCENT}
          max={MAX_TARGET_PERCENT}
          defaultValue={targetPercent}
          required
        />
      </Field>
      <Field label="Rolling window (days)" htmlFor={`${idPrefix}-window`}>
        <Input
          id={`${idPrefix}-window`}
          name="windowDays"
          type="number"
          min={MIN_WINDOW_DAYS}
          max={MAX_WINDOW_DAYS}
          defaultValue={windowDays}
          required
        />
      </Field>
    </>
  );
}

export function SloCreateForm({ csrf, monitors }: { csrf: ReactNode; monitors: Candidate[] }) {
  const [state, formAction] = useActionState(saveSloAction, undefined);
  const available = monitors.filter((m) => !m.hasSlo);

  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle>New SLO</CardTitle>
        <CardDescription>
          One target per monitor. The error budget is what the target permits you to fail before it is breached.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && <Alert tone="accent">SLO saved.</Alert>}
          {available.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-4 text-center text-xs text-ink-3">
              {monitors.length === 0 ? "Create a monitor first." : "Every monitor already has an SLO."}
            </p>
          ) : (
            <>
              <Field label="Monitor" htmlFor="slo-monitor">
                <Select id="slo-monitor" name="monitorId" required>
                  {available.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <TargetFields idPrefix="slo" targetPercent={99.9} windowDays={30} />
              <Submit label="Create SLO" />
            </>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function SloEditForm({
  csrf,
  monitorId,
  targetPercent,
  windowDays,
}: {
  csrf: ReactNode;
  monitorId: string;
  targetPercent: number;
  windowDays: number;
}) {
  const [state, formAction] = useActionState(saveSloAction, undefined);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit target
      </Button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-3 rounded-lg border border-line bg-surface-3/40 p-3">
      {csrf}
      <input type="hidden" name="monitorId" value={monitorId} />
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Target updated.</Alert>}
      <TargetFields idPrefix={`slo-${monitorId}`} targetPercent={targetPercent} windowDays={windowDays} />
      <div className="flex items-center gap-2">
        <Submit label="Save target" full={false} />
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}
