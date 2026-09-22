"use client";

import { Plus, Trash2 } from "lucide-react";
import { ASSERTION_KINDS, ASSERTION_OPERATORS } from "@sentinel/shared";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select } from "@/components/ui";
import type { MonitorAssertionValue } from "./types";

export type AssertionsCardProps = {
  assertions: MonitorAssertionValue[];
  onAddAssertion: () => void;
  onRemoveAssertion: (index: number) => void;
};

export function AssertionsCard({ assertions, onAddAssertion, onRemoveAssertion }: AssertionsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Assertions</CardTitle>
        <CardDescription>A check that returns 200 but renders an error page is still down. Assertions catch that.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {assertions.map((a, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[9rem_1fr_9rem_1fr_auto]">
            <Select name="assertionKind" defaultValue={a.kind} aria-label="Assertion kind">
              {ASSERTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
            <Input name="assertionTarget" defaultValue={a.target} placeholder="$.status or header name" className="font-mono text-xs" aria-label="Assertion target" />
            <Select name="assertionOperator" defaultValue={a.operator} aria-label="Assertion operator">
              {ASSERTION_OPERATORS.map((o) => (
                <option key={o} value={o}>
                  {o.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
            <Input name="assertionValue" defaultValue={a.value} placeholder="healthy" className="font-mono text-xs" aria-label="Assertion value" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemoveAssertion(i)}
              aria-label="Remove assertion"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAddAssertion}
        >
          <Plus className="size-4" />
          Add assertion
        </Button>
      </CardContent>
    </Card>
  );
}
