import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Trash2 } from "lucide-react";
import { SloEditForm } from "@/components/slo-forms";
import { BudgetBar, BurnBadge, budgetRemainingLabel, budgetSubLabel, budgetTone } from "@/components/slo-status";
import { StatusPill, UptimeBar, UptimeLegend } from "@/components/status";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, LinkButton, Stat } from "@/components/ui";
import { deleteSloAction } from "@/lib/actions/slos";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { hasRole } from "@/lib/rbac";
import { availabilityPercent, daysUntilExhausted, type ErrorBudget } from "@/lib/slo";
import { getSloDetail } from "@/lib/slo-queries";
import { formatPercent } from "@/lib/utils";

type Props = { params: Promise<{ monitorId: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { monitorId } = await params;
  const { org } = await requireOrg();
  const slo = await getSloDetail(org.id, monitorId);
  return { title: slo ? `SLO — ${slo.monitorName}` : "SLO" };
}

function burnValue(budget: ErrorBudget): string {
  return budget.state === "measured" ? `${budget.burnRate.toFixed(2)}×` : "—";
}

export default async function SloDetailPage({ params }: Props) {
  const { monitorId } = await params;
  const { org } = await requireOrg();
  const slo = await getSloDetail(org.id, monitorId);
  if (!slo) notFound();

  const canEdit = hasRole(org.role, "member");
  const availability = availabilityPercent(slo.budget);
  const exhaustion = daysUntilExhausted(slo.budget, slo.windowDays);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/slos" className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink-2">
        <ChevronLeft className="size-4" />
        Service levels
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{slo.monitorName}</h1>
            <StatusPill status={slo.status} size="sm" />
            <BurnBadge budget={slo.budget} />
          </div>
          <p className="mt-1.5 break-all font-mono text-sm text-ink-3">{slo.monitorUrl}</p>
          <p className="mt-1 text-xs text-ink-3">
            target {formatPercent(slo.targetPercent, 3)} over a rolling {slo.windowDays} days ·{" "}
            {slo.totalChecks.toLocaleString()} checks, {slo.failedChecks.toLocaleString()} failed
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/monitors/${slo.monitorId}`} variant="outline" size="sm">
            Open monitor
          </LinkButton>
          {canEdit && (
            <form action={deleteSloAction.bind(null, slo.monitorId)}>
              <Button type="submit" variant="danger" size="sm">
                <Trash2 className="size-4" />
                Remove SLO
              </Button>
            </form>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <Stat
              label="Error budget left"
              value={budgetRemainingLabel(slo.budget)}
              sub={budgetSubLabel(slo.budget, slo.windowDays)}
              tone={budgetTone(slo.budget)}
            />
            <BudgetBar budget={slo.budget} className="mt-3" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat
              label="Observed availability"
              value={availability === null ? "—" : formatPercent(availability, 3)}
              sub={`against a ${formatPercent(slo.targetPercent, 3)} target`}
              tone={availability !== null && availability < slo.targetPercent ? "down" : "up"}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat
              label={`Burn rate · ${slo.windowDays}d`}
              value={burnValue(slo.budget)}
              sub={exhaustion === null ? "budget not being spent" : `budget gone in ${exhaustion.toFixed(1)}d at this rate`}
              tone={budgetTone(slo.budget)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat
              label="Burn rate · 1h / 6h"
              value={`${burnValue(slo.burn1h)} / ${burnValue(slo.burn6h)}`}
              sub="short-horizon spend, from 5m rollups"
              tone={budgetTone(slo.burn1h)}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Daily availability</CardTitle>
          <CardDescription>One slot per day of the SLO window. Grey slots collected no checks.</CardDescription>
        </CardHeader>
        <CardContent>
          <UptimeBar slots={slo.days} className="h-10" />
          <UptimeLegend days={slo.windowDays} className="mt-2" />
        </CardContent>
      </Card>

      {canEdit && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Target</CardTitle>
            <CardDescription>Changing the target or window re-derives the budget from the same rollups.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <SloEditForm
              csrf={<CsrfInput />}
              monitorId={slo.monitorId}
              targetPercent={slo.targetPercent}
              windowDays={slo.windowDays}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
