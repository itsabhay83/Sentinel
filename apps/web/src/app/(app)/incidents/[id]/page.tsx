import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, ChevronLeft } from "lucide-react";
import { explainFailure, isFailureCode } from "@sentinel/shared";
import { PostmortemForm } from "@/components/postmortem-form";
import { FailureBadge } from "@/components/status";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Stat } from "@/components/ui";
import { acknowledgeIncidentAction } from "@/lib/actions/incidents";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { getIncident, getIncidentEvents } from "@/lib/queries";
import { formatDateTime, humanDuration, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Incident" };
export const dynamic = "force-dynamic";

const EVENT_LABEL: Record<string, string> = {
  opened: "Incident opened",
  region_failed: "Region started failing",
  region_recovered: "Region recovered",
  escalated: "Escalated",
  acked: "Acknowledged",
  resolved: "Resolved",
  note: "Note",
  flapping_detected: "Flapping detected",
  severity_changed: "Severity changed",
};

const EVENT_TONE: Record<string, string> = {
  opened: "bg-down",
  region_failed: "bg-partial",
  region_recovered: "bg-up",
  escalated: "bg-degraded",
  acked: "bg-info",
  resolved: "bg-up",
  note: "bg-line-strong",
  flapping_detected: "bg-degraded",
  severity_changed: "bg-partial",
};

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { org } = await requireOrg();
  const incident = await getIncident(org.id, id);
  if (!incident) notFound();
  const events = await getIncidentEvents(incident.id);
  const info = incident.primaryFailureCode && isFailureCode(incident.primaryFailureCode) ? explainFailure(incident.primaryFailureCode) : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/incidents" className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink-2">
        <ChevronLeft className="size-4" />
        Incidents
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              <Link href={`/monitors/${incident.monitorId}`} className="transition-colors hover:text-accent">
                {incident.monitorName}
              </Link>
            </h1>
            <Badge tone={incident.resolvedAt ? "neutral" : incident.severity === "down" ? "danger" : "warn"}>
              {incident.resolvedAt ? "resolved" : incident.severity}
            </Badge>
            {incident.isFlapping && <Badge tone="warn">flapping</Badge>}
          </div>
          <p className="mt-1.5 break-all font-mono text-sm text-ink-3">{incident.monitorUrl}</p>
        </div>
        {!incident.acknowledgedAt && !incident.resolvedAt && (
          <form action={acknowledgeIncidentAction.bind(null, incident.id)}>
            <Button type="submit" variant="secondary">
              <Check className="size-4" />
              Acknowledge
            </Button>
          </form>
        )}
      </header>

      {info && (
        <Alert tone={incident.resolvedAt ? "accent" : "danger"} className="mt-5">
          <strong className="font-medium">{info.label}</strong> — {info.explanation} <span className="text-ink-2">{info.suggestedAction}</span>
        </Alert>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <Stat label="Started" value={relativeTime(incident.startedAt)} sub={formatDateTime(incident.startedAt)} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat label="Duration" value={humanDuration(incident.startedAt, incident.resolvedAt)} sub={incident.resolvedAt ? `resolved ${relativeTime(incident.resolvedAt)}` : "ongoing"} tone={incident.resolvedAt ? "up" : "down"} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat label="Affected regions" value={String(incident.affectedRegions.length)} sub={incident.affectedRegions.join(", ") || "—"} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <Stat label="Acknowledged" value={incident.acknowledgedAt ? "Yes" : "No"} sub={incident.acknowledgedAt ? relativeTime(incident.acknowledgedAt) : "escalation active"} tone={incident.acknowledgedAt ? "up" : "muted"} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-5 border-l border-line pl-5">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span className={`absolute -left-[1.6rem] top-1.5 size-2.5 rounded-full ring-4 ring-canvas ${EVENT_TONE[e.kind] ?? "bg-line-strong"}`} />
                  <p className="text-sm text-ink">{EVENT_LABEL[e.kind] ?? e.kind}</p>
                  <p className="mt-0.5 text-xs text-ink-3">{formatDateTime(e.at)}</p>
                  {Object.keys(e.payload ?? {}).length > 0 && (
                    <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-surface-2/50 p-2 font-mono text-[11px] text-ink-2">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
              {events.length === 0 && <li className="text-sm text-ink-3">No events recorded.</li>}
            </ol>
          </CardContent>
        </Card>

        <div className="space-y-5">
          {incident.primaryFailureCode && isFailureCode(incident.primaryFailureCode) && (
            <Card>
              <CardHeader>
                <CardTitle>Root cause signal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <FailureBadge code={incident.primaryFailureCode} phase={explainFailure(incident.primaryFailureCode).phase} />
                <p className="text-sm leading-relaxed text-ink-2">{explainFailure(incident.primaryFailureCode).explanation}</p>
                <p className="text-sm leading-relaxed text-ink-3">{explainFailure(incident.primaryFailureCode).suggestedAction}</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Postmortem</CardTitle>
            </CardHeader>
            <CardContent>
              <PostmortemForm incidentId={incident.id} initial={incident.postmortem ?? ""} csrf={<CsrfInput />} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
