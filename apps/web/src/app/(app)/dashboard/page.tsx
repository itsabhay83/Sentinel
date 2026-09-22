import type { Metadata } from "next";
import { Activity, Plus } from "lucide-react";
import { MonitorList } from "@/components/monitor-list";
import { UptimeLegend } from "@/components/status";
import { Card, CardContent, EmptyState, LinkButton, Stat } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { getDashboardMonitors, getOrgSummary } from "@/lib/queries";
import { formatMs, formatPercent } from "@/lib/utils";

export const metadata: Metadata = { title: "Monitors" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { org } = await requireOrg();
  const [monitors, summary] = await Promise.all([getDashboardMonitors(org.id), getOrgSummary(org.id)]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monitors</h1>
          <p className="mt-1 text-sm text-ink-2">
            {summary.total} monitors across {org.name}
            {summary.openIncidents > 0 && (
              <>
                {" · "}
                <span className="text-down">
                  {summary.openIncidents} open incident{summary.openIncidents === 1 ? "" : "s"}
                </span>
              </>
            )}
          </p>
        </div>
        <LinkButton href="/monitors/new">
          <Plus className="size-4" />
          New monitor
        </LinkButton>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <Stat label="Operational" value={String(summary.up)} sub={`${summary.paused} paused`} tone="up" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat
              label="Failing"
              value={String(summary.down + summary.partial)}
              sub={`${summary.degraded} degraded`}
              tone={summary.down + summary.partial > 0 ? "down" : "muted"}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat
              label="Uptime · 24h"
              value={summary.uptime24h == null ? "—" : `${formatPercent(summary.uptime24h, 3)}`}
              sub={`${summary.checksToday.toLocaleString()} checks today`}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat label="Slowest p95 · 24h" value={summary.p95_24h == null ? "—" : formatMs(summary.p95_24h)} sub="across all regions" />
          </CardContent>
        </Card>
      </div>

      <div className="mt-8">
        {monitors.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-6" />}
            title="No monitors yet"
            description="Add your first endpoint and Sentinel will start checking it from every enabled region within a minute."
            action={<LinkButton href="/monitors/new">Create your first monitor</LinkButton>}
          />
        ) : (
          <>
            <MonitorList monitors={monitors} />
            <UptimeLegend days={90} className="mt-6 px-1" />
          </>
        )}
      </div>
    </div>
  );
}
