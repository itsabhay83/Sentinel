"use client";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import type { MonitorFormValues } from "./types";

export type ConsensusCardProps = {
  initial: MonitorFormValues;
  advanced: boolean;
  onToggleAdvanced: () => void;
};

export function ConsensusCard({ initial, advanced, onToggleAdvanced }: ConsensusCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Consensus &amp; organization</CardTitle>
          <CardDescription>How many regions must agree, and how quickly Sentinel commits to a verdict.</CardDescription>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onToggleAdvanced}>
          {advanced ? "Hide" : "Show"}
        </Button>
      </CardHeader>
      {advanced && (
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Quorum ratio" htmlFor="quorumRatio" hint="0.6 = 60% of reporting regions must fail.">
            <Input id="quorumRatio" name="quorumRatio" type="number" min={0.1} max={1} step={0.05} defaultValue={initial.quorumRatio} />
          </Field>
          <Field label="Minimum regions" htmlFor="minRegionsRequired" hint="Below this, the cycle is inconclusive.">
            <Input id="minRegionsRequired" name="minRegionsRequired" type="number" min={1} max={8} defaultValue={initial.minRegionsRequired} />
          </Field>
          <Field label="Failures to confirm" htmlFor="confirmationFailures">
            <Input id="confirmationFailures" name="confirmationFailures" type="number" min={1} max={10} defaultValue={initial.confirmationFailures} />
          </Field>
          <Field label="Successes to recover" htmlFor="confirmationSuccesses">
            <Input id="confirmationSuccesses" name="confirmationSuccesses" type="number" min={1} max={10} defaultValue={initial.confirmationSuccesses} />
          </Field>
          <Field label="Degraded above (ms)" htmlFor="degradedThresholdMs" hint="Blank uses an automatic baseline.">
            <Input id="degradedThresholdMs" name="degradedThresholdMs" type="number" min={1} defaultValue={initial.degradedThresholdMs} placeholder="auto" />
          </Field>
          <Field label="Max redirects" htmlFor="maxRedirects">
            <Input id="maxRedirects" name="maxRedirects" type="number" min={0} max={5} defaultValue={initial.maxRedirects} />
          </Field>
          <Field label="Group" htmlFor="groupName">
            <Input id="groupName" name="groupName" defaultValue={initial.groupName} placeholder="API" />
          </Field>
          <Field label="Tags" htmlFor="tags" hint="Comma separated.">
            <Input id="tags" name="tags" defaultValue={initial.tags} placeholder="critical,public" />
          </Field>
          <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-ink-2">
            <input type="checkbox" name="followRedirects" defaultChecked={initial.followRedirects} className="size-4 accent-[--color-accent]" />
            Follow redirects
          </label>
        </CardContent>
      )}
      {!advanced && (
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Group" htmlFor="groupName-simple">
            <Input id="groupName-simple" name="groupName" defaultValue={initial.groupName} placeholder="API" />
          </Field>
          <Field label="Tags" htmlFor="tags-simple" hint="Comma separated.">
            <Input id="tags-simple" name="tags" defaultValue={initial.tags} placeholder="critical,public" />
          </Field>
          {/* Advanced values still submit while the panel is collapsed. */}
          <input type="hidden" name="quorumRatio" value={initial.quorumRatio} />
          <input type="hidden" name="minRegionsRequired" value={initial.minRegionsRequired} />
          <input type="hidden" name="confirmationFailures" value={initial.confirmationFailures} />
          <input type="hidden" name="confirmationSuccesses" value={initial.confirmationSuccesses} />
          <input type="hidden" name="degradedThresholdMs" value={initial.degradedThresholdMs} />
          <input type="hidden" name="maxRedirects" value={initial.maxRedirects} />
          {initial.followRedirects && <input type="hidden" name="followRedirects" value="on" />}
        </CardContent>
      )}
    </Card>
  );
}
