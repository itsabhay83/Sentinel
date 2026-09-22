import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { explainFailure, isFailureCode } from "@sentinel/shared";
import { FailureBadge } from "@/components/status";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { getIncidents } from "@/lib/queries";
import { formatDateTime, humanDuration } from "@/lib/utils";

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const { org } = await requireOrg();
  const incidents = await getIncidents(org.id, { limit: 100 });
  const open = incidents.filter((i) => i.resolvedAt === null);
  const resolved = incidents.filter((i) => i.resolvedAt !== null);

  function renderRow(i: (typeof incidents)[number]) {
    return (
      <Link
        key={i.id}
        href={`/incidents/${i.id}`}
        className="flex flex-wrap items-center gap-3 border-b border-line/60 px-4 py-3 transition-colors last:border-0 hover:bg-surface-2/60"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-ink">{i.monitorName}</span>
            <Badge tone={i.severity === "down" ? "danger" : i.severity === "partial" ? "warn" : "info"}>{i.severity}</Badge>
            {i.isFlapping && <Badge tone="warn">flapping</Badge>}
            {i.acknowledgedAt && <Badge tone="neutral">acknowledged</Badge>}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-ink-3">{i.monitorUrl}</span>
        </span>
        {i.primaryFailureCode && isFailureCode(i.primaryFailureCode) && (
          <FailureBadge code={i.primaryFailureCode} phase={explainFailure(i.primaryFailureCode).phase} />
        )}
        <span className="hidden text-xs text-ink-3 sm:block">{i.affectedRegions.join(", ") || "—"}</span>
        <span className="w-28 text-right text-xs text-ink-3">{humanDuration(i.startedAt, i.resolvedAt)}</span>
        <span className="hidden w-40 text-right text-xs text-ink-3 lg:block">{formatDateTime(i.startedAt)}</span>
      </Link>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
      <p className="mt-1 text-sm text-ink-2">
        {open.length} open · {resolved.length} resolved in the last 100
      </p>

      {incidents.length === 0 ? (
        <div className="mt-8">
          <EmptyState icon={<ShieldCheck className="size-6" />} title="No incidents" description="Nothing has gone wrong yet. Sentinel will open an incident the moment a quorum of regions agrees something is down." />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {open.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-down">Open</CardTitle>
              </CardHeader>
              <CardContent className="px-0">{open.map(renderRow)}</CardContent>
            </Card>
          )}
          {resolved.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Resolved</CardTitle>
              </CardHeader>
              <CardContent className="px-0">{resolved.map(renderRow)}</CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
