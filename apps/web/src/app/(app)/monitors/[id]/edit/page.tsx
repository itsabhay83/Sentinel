import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { decryptJson } from "@sentinel/shared/server";
import { getServerEnv } from "@sentinel/shared/env";
import { MonitorForm, type MonitorFormValues } from "@/components/monitor-form";
import { updateMonitorAction } from "@/lib/actions/monitors";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { getMonitor } from "@/lib/queries";

export const metadata: Metadata = { title: "Edit monitor" };
export const dynamic = "force-dynamic";

export default async function EditMonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { org } = await requireOrg();
  const monitor = await getMonitor(org.id, id);
  if (!monitor) notFound();

  // Headers and body are decrypted here, on the server, and only for a member of
  // the owning organization. They are never sent to the client in ciphertext form
  // and never leave this request otherwise.
  const key = getServerEnv().ENCRYPTION_KEY;
  const headers = monitor.headersEncrypted ? decryptJson<Record<string, string>>(monitor.headersEncrypted, key, {}) : {};
  const body = monitor.bodyEncrypted ? decryptJson<{ value: string }>(monitor.bodyEncrypted, key, { value: "" }).value : "";

  const initial: MonitorFormValues = {
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    method: monitor.method,
    headers: Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
    body,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    followRedirects: monitor.followRedirects,
    maxRedirects: monitor.maxRedirects,
    expectedStatusCodes: monitor.expectedStatusCodes.join(","),
    regions: monitor.regions,
    quorumRatio: monitor.quorumRatio,
    minRegionsRequired: monitor.minRegionsRequired,
    confirmationFailures: monitor.confirmationFailures,
    confirmationSuccesses: monitor.confirmationSuccesses,
    degradedThresholdMs: monitor.degradedThresholdMs == null ? "" : String(monitor.degradedThresholdMs),
    groupName: monitor.groupName ?? "",
    tags: monitor.tags.join(","),
    assertions: monitor.assertions.map((a) => ({ kind: a.kind, target: a.target ?? "", operator: a.operator, value: a.value })),
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href={`/monitors/${monitor.id}`} className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink-2">
        <ChevronLeft className="size-4" />
        {monitor.name}
      </Link>
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">Edit monitor</h1>
      <MonitorForm action={updateMonitorAction.bind(null, monitor.id)} csrf={<CsrfInput />} initial={initial} submitLabel="Save changes" />
    </div>
  );
}
