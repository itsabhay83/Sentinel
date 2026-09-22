import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { EMPTY_MONITOR, MonitorForm } from "@/components/monitor-form";
import { createMonitorAction } from "@/lib/actions/monitors";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";

export const metadata: Metadata = { title: "New monitor" };

export default async function NewMonitorPage() {
  await requireOrg();
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink-2">
        <ChevronLeft className="size-4" />
        Monitors
      </Link>
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">New monitor</h1>
      <MonitorForm action={createMonitorAction} csrf={<CsrfInput />} initial={EMPTY_MONITOR} submitLabel="Create monitor" />
    </div>
  );
}
