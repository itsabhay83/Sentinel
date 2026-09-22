"use client";

import { CHECK_INTERVALS } from "@sentinel/shared";
import { Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import type { MonitorFormValues } from "./types";

export type ScheduleCardProps = {
  initial: MonitorFormValues;
};

export function ScheduleCard({ initial }: ScheduleCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <Field label="Interval" htmlFor="intervalSeconds">
          <Select id="intervalSeconds" name="intervalSeconds" defaultValue={String(initial.intervalSeconds)}>
            {CHECK_INTERVALS.map((s) => (
              <option key={s} value={s}>
                {s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s / 3600} hour${s === 3600 ? "" : "s"}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Timeout (ms)" htmlFor="timeoutMs">
          <Input id="timeoutMs" name="timeoutMs" type="number" min={1000} max={120000} step={1000} defaultValue={initial.timeoutMs} />
        </Field>
        <Field label="Expected status codes" htmlFor="expectedStatusCodes" hint="Comma separated. Blank means 2xx–3xx.">
          <Input id="expectedStatusCodes" name="expectedStatusCodes" defaultValue={initial.expectedStatusCodes} placeholder="200,201,204" />
        </Field>
      </CardContent>
    </Card>
  );
}
