"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Textarea } from "@/components/ui";
import { savePostmortemAction } from "@/lib/actions/incidents";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending}>
      {pending ? "Saving…" : "Save postmortem"}
    </Button>
  );
}

export function PostmortemForm({ incidentId, initial, csrf }: { incidentId: string; initial: string; csrf: ReactNode }) {
  const [state, formAction] = useActionState(savePostmortemAction.bind(null, incidentId), undefined);

  return (
    <form action={formAction} className="space-y-3">
      {csrf}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="accent">Postmortem saved.</Alert>}
      <Textarea
        name="postmortem"
        rows={8}
        defaultValue={initial}
        placeholder="What happened, what caused it, and what stops it happening again."
        className="text-sm leading-relaxed"
      />
      <SaveButton />
    </form>
  );
}
