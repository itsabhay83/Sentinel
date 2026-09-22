import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Rss } from "lucide-react";
import type { MonitorStatus } from "@sentinel/shared";
import { statusLabel } from "@sentinel/shared";
import { StatusPill, UptimeBar, UptimeLegend } from "@/components/status";
import { StatusPageLock, SubscribeForm } from "@/components/status-gate";
import { getPublishedMaintenance } from "@/lib/maintenance";
import { getStatusPage, getStatusPageAccess } from "@/lib/queries";
import { hasStatusPageGrant } from "@/lib/status-gate";
import { cn, formatDateTime, formatPercent, humanDuration } from "@/lib/utils";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ subscribed?: string; unsubscribed?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const access = await getStatusPageAccess(slug);
  if (!access) return { title: "Status" };
  // A protected page still needs a title to render its lock screen, but must not
  // advertise its description to crawlers that will never be let past the door.
  if (access.passwordHash !== null) return { title: access.title, robots: { index: false, follow: false } };
  return {
    title: access.title,
    description: access.description ?? `Live availability for ${access.title}.`,
    openGraph: { title: access.title, description: access.description ?? undefined },
  };
}

function overallStatus(groups: Awaited<ReturnType<typeof getStatusPage>> extends null ? never : NonNullable<Awaited<ReturnType<typeof getStatusPage>>>["groups"]): MonitorStatus {
  const all = groups.flatMap((g) => g.monitors.map((m) => m.status));
  if (all.some((s) => s === "DOWN")) return "DOWN";
  if (all.some((s) => s === "PARTIAL_OUTAGE")) return "PARTIAL_OUTAGE";
  if (all.some((s) => s === "DEGRADED")) return "DEGRADED";
  return "UP";
}

const HEADLINE: Record<MonitorStatus, string> = {
  UP: "All systems operational",
  DEGRADED: "Degraded performance",
  PARTIAL_OUTAGE: "Partial service disruption",
  DOWN: "Major service outage",
  PAUSED: "Monitoring paused",
  INCONCLUSIVE: "Awaiting data",
  PENDING: "Awaiting first checks",
};

export default async function PublicStatusPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const access = await getStatusPageAccess(slug);
  if (!access) notFound();

  // The expensive rollup query below never runs for a visitor who has not cleared
  // the gate, so an unauthenticated flood costs one indexed lookup, not a scan.
  if (!(await hasStatusPageGrant(access.id, access.passwordHash))) {
    return <StatusPageLock slug={slug} title={access.title} accent={access.theme?.accent ?? "#10b981"} />;
  }

  const [page, maintenance] = await Promise.all([getStatusPage(slug), getPublishedMaintenance(slug)]);
  if (!page) notFound();

  const overall = overallStatus(page.groups);
  const accent = page.theme?.accent ?? "#10b981";
  const activeIncidents = page.incidents.filter((i) => i.resolvedAt === null);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
          {page.description && <p className="mt-1 text-sm text-ink-2">{page.description}</p>}
        </div>
        <a
          href={`/status/${page.slug}/rss`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-3 transition-colors hover:text-ink-2"
        >
          <Rss className="size-3.5" />
          RSS
        </a>
      </header>

      <section
        className={cn(
          "mt-8 flex flex-wrap items-center gap-4 rounded-xl border p-5",
          overall === "UP" ? "border-up/25 bg-up/[0.06]" : overall === "DOWN" ? "border-down/25 bg-down/[0.06]" : "border-degraded/25 bg-degraded/[0.06]",
        )}
      >
        <span
          className="pulse-dot relative size-3 rounded-full"
          style={{ background: overall === "UP" ? accent : overall === "DOWN" ? "#ef4444" : "#f59e0b" }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-medium">{HEADLINE[overall]}</p>
          <p className="mt-0.5 text-sm text-ink-3">Updated {formatDateTime(new Date())}</p>
        </div>
      </section>

      {activeIncidents.length > 0 && (
        <section className="mt-6 space-y-3">
          {activeIncidents.map((i) => (
            <article key={i.id} className="rounded-xl border border-down/25 bg-down/[0.05] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-down">
                  {i.severity === "down" ? "Outage" : i.severity === "partial" ? "Partial outage" : "Degraded"} — {i.monitorName}
                </span>
                <span className="text-xs text-ink-3">started {formatDateTime(i.startedAt)}</span>
              </div>
              <ol className="mt-3 space-y-2 border-l border-line pl-4">
                {i.events.slice(-4).map((e) => (
                  <li key={e.id} className="relative text-sm text-ink-2">
                    <span className="absolute -left-[1.32rem] top-2 size-1.5 rounded-full bg-line-strong ring-2 ring-canvas" />
                    <span className="capitalize">{e.kind.replace(/_/g, " ")}</span>
                    <span className="ml-2 text-xs text-ink-3">{formatDateTime(e.at)}</span>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </section>
      )}

      {maintenance.length > 0 && (
        <section className="mt-6 space-y-3">
          {maintenance.map((w) => (
            <article key={w.id} className="rounded-xl border border-inconclusive/25 bg-inconclusive/[0.05] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-inconclusive">
                  {w.status === "in_progress" ? "Maintenance in progress" : "Scheduled maintenance"}
                  {w.reason ? ` — ${w.reason}` : ""}
                </span>
                <span className="text-xs text-ink-3">
                  {formatDateTime(w.startsAt)} → {formatDateTime(w.endsAt)}
                </span>
              </div>
              {w.services.length > 0 && <p className="mt-2 text-sm text-ink-2">Affects {w.services.join(", ")}</p>}
            </article>
          ))}
        </section>
      )}

      <section className="mt-8 space-y-6">
        {page.groups.map((group) => (
          <div key={group.name}>
            <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-ink-3">{group.name}</h2>
            <div className="overflow-hidden rounded-xl border border-line bg-surface/60">
              {group.monitors.map((m, i) => (
                <div key={m.id} className={cn("px-4 py-4", i > 0 && "border-t border-line/70")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{m.displayName}</span>
                    <span className="flex items-center gap-3">
                      <span className="tnum text-sm text-ink-2">{m.uptime == null ? "—" : `${formatPercent(m.uptime, 2)}`}</span>
                      <StatusPill status={m.status} size="sm" />
                    </span>
                  </div>
                  <UptimeBar slots={m.days} className="mt-3 h-7" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <UptimeLegend days={page.showUptimeDays} className="mt-4 px-1" />

      <section className="mt-10 rounded-xl border border-line bg-surface/40 p-5">
        <h2 className="text-sm font-medium">Get incident updates by email</h2>
        <p className="mb-3.5 mt-1 text-sm text-ink-3">
          One message when something breaks, one when it is fixed. Unsubscribe from any of them.
        </p>
        {query.subscribed === "1" ? (
          <p className="text-sm text-up">You are subscribed. We will email you when this page changes.</p>
        ) : query.unsubscribed === "1" ? (
          <p className="text-sm text-ink-2">You have been unsubscribed. Sign up again below at any time.</p>
        ) : null}
        <SubscribeForm slug={page.slug} accent={accent} />
      </section>

      {page.incidents.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-3">Past incidents</h2>
          <div className="space-y-2">
            {page.incidents
              .filter((i) => i.resolvedAt !== null)
              .slice(0, 10)
              .map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface/40 px-3 py-2.5 text-sm">
                  <span className="size-1.5 rounded-full bg-ink-3" />
                  <span className="text-ink-2">{i.monitorName}</span>
                  <span className="text-xs text-ink-3">{formatDateTime(i.startedAt)}</span>
                  <span className="ml-auto text-xs text-ink-3">resolved after {humanDuration(i.startedAt, i.resolvedAt)}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <footer className="mt-16 border-t border-line/60 pt-6 text-center text-xs text-ink-3">
        <p>
          {statusLabel(overall)} · Monitored from multiple regions by <span className="text-ink-2">Sentinel</span>
        </p>
      </footer>
    </main>
  );
}
