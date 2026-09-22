"use client";

import type { ReactNode } from "react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button } from "@/components/ui";
import type { ActionState } from "@/lib/actions/monitors";
import { AssertionsCard } from "./assertions-card";
import { ConsensusCard } from "./consensus-card";
import { RegionsCard } from "./regions-card";
import { ScheduleCard } from "./schedule-card";
import { TargetCard } from "./target-card";
import type { MonitorFormValues } from "./types";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

export function MonitorForm({
  action,
  csrf,
  initial,
  submitLabel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  csrf: ReactNode;
  initial: MonitorFormValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  const [type, setType] = useState(initial.type);
  const [regions, setRegions] = useState<string[]>(initial.regions);
  const [assertions, setAssertions] = useState(initial.assertions);
  const [advanced, setAdvanced] = useState(false);

  function toggleRegion(code: string) {
    setRegions((prev) => (prev.includes(code) ? prev.filter((r) => r !== code) : [...prev, code]));
  }

  return (
    <form action={formAction} className="space-y-5">
      {csrf}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <TargetCard initial={initial} type={type} onTypeChange={setType} />

      <RegionsCard regions={regions} quorumRatio={initial.quorumRatio} onToggleRegion={toggleRegion} />

      <ScheduleCard initial={initial} />

      <AssertionsCard
        assertions={assertions}
        onAddAssertion={() => setAssertions((prev) => [...prev, { kind: "keyword", target: "", operator: "contains", value: "" }])}
        onRemoveAssertion={(index) => setAssertions((prev) => prev.filter((_, idx) => idx !== index))}
      />

      <ConsensusCard initial={initial} advanced={advanced} onToggleAdvanced={() => setAdvanced((v) => !v)} />

      <div className="flex justify-end gap-2">
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  );
}
