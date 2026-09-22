"use client";

import { MONITOR_TYPES } from "@sentinel/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import type { MonitorFormValues } from "./types";

const TYPE_HINTS: Record<string, string> = {
  http: "Full HTTP(S) request with assertions and phase timing.",
  tcp: "Opens a TCP connection. Use host:port — for example db.internal:5432.",
  ping: "ICMP echo. Use a bare hostname or IP.",
  dns: "Resolves a record. Use dns://example.com?type=A&expect=93.184.216.34",
  heartbeat: "Inbound: your job pings Sentinel. A ping URL is issued after you save.",
  flow: "Multi-step API flow. Configure the steps after creating the monitor.",
};

export type TargetCardProps = {
  initial: MonitorFormValues;
  type: string;
  onTypeChange: (type: string) => void;
};

export function TargetCard({ initial, type, onTypeChange }: TargetCardProps) {
  const needsHttpFields = type === "http" || type === "flow";

  return (
    <Card>
      <CardHeader>
        <CardTitle>What to check</CardTitle>
        <CardDescription>{TYPE_HINTS[type]}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name" className="sm:col-span-2">
          <Input id="name" name="name" required defaultValue={initial.name} placeholder="API — checkout" />
        </Field>
        <Field label="Type" htmlFor="type">
          <Select id="type" name="type" value={type} onChange={(e) => onTypeChange(e.target.value)}>
            {MONITOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Method" htmlFor="method">
          <Select id="method" name="method" defaultValue={initial.method} disabled={!needsHttpFields}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target" htmlFor="url" className="sm:col-span-2" hint={type === "tcp" ? "host:port" : undefined}>
          <Input id="url" name="url" required defaultValue={initial.url} className="font-mono text-sm" placeholder="https://api.example.com/health" />
        </Field>
        {needsHttpFields && (
          <>
            <Field label="Request headers" htmlFor="headers" className="sm:col-span-2" hint="One per line — Authorization: Bearer … Encrypted at rest.">
              <Textarea id="headers" name="headers" rows={3} defaultValue={initial.headers} className="font-mono text-xs" placeholder={"Authorization: Bearer sk_live_…\nAccept: application/json"} />
            </Field>
            <Field label="Request body" htmlFor="body" className="sm:col-span-2" hint="Encrypted at rest.">
              <Textarea id="body" name="body" rows={3} defaultValue={initial.body} className="font-mono text-xs" placeholder='{"query":"health"}' />
            </Field>
          </>
        )}
      </CardContent>
    </Card>
  );
}
