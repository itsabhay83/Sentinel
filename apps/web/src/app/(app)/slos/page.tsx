import type { Metadata } from "next";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { SloCreateForm } from "@/components/slo-forms";
import { BudgetBar, BurnBadge, budgetRemainingLabel } from "@/components/slo-status";
import { StatusPill } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { hasRole } from "@/lib/rbac";
import { availabilityPercent } from "@/lib/slo";
import { listSloCandidates, listSlos } from "@/lib/slo-queries";
import { formatPercent } from "@/lib/utils";

export const metadata: Metadata = { title: "SLOs" };
export const dynamic = "force-dynamic";

export default async function SlosPage() {
  const { org } = await requireOrg();
  const [slos, candidates] = await Promise.all([listSlos(org.id), listSloCandidates(org.id)]);

  const canEdit = hasRole(org.role, "member");
  const breached = slos.filter((s) => s.budget.state === "measured" && s.budget.remainingRatio <= 0).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Service levels</h1>
      <p className="mt-1 text-sm text-ink-2">
        {slos.length === 0
          ? "No availability targets set yet."
          : `${slos.length} target${slos.length === 1 ? "" : "s"}${breached > 0 ? ` · ${breached} out of budget` : ""}.`}
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Error budgets</CardTitle>
            <CardDescription>
              Burn rate 1 spends the budget exactly over the window; above 1 it runs out early.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {slos.length === 0 && (
              <EmptyState
                icon={<Gauge />}
                title="No SLOs yet"
                description="Pick a monitor and a target, and Sentinel turns its rollups into an error budget you can spend."
              />
            )}
            {slos.map((slo) => {
              const availability = availabilityPercent(slo.budget);
              return (
                <Link
                  key={slo.monitorId}
                  href={`/slos/${slo.monitorId}`}
                  className="block rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition-colors hover:border-line-strong"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{slo.monitorName}</span>
                    <StatusPill status={slo.status} size="sm" />
                    <BurnBadge budget={slo.budget} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <BudgetBar budget={slo.budget} className="flex-1" />
                    <span className="tnum shrink-0 text-xs text-ink-2">{budgetRemainingLabel(slo.budget)} left</span>
                  </div>
                  <p className="mt-1.5 text-xs text-ink-3">
                    target {formatPercent(slo.targetPercent, 3)} over {slo.windowDays}d · observed{" "}
                    {availability === null ? "—" : formatPercent(availability, 3)} · {slo.totalChecks.toLocaleString()} checks
                  </p>
                </Link>
              );
            })}
          </CardContent>
        </Card>

        {canEdit && <SloCreateForm csrf={<CsrfInput />} monitors={candidates} />}
      </div>
    </div>
  );
}
