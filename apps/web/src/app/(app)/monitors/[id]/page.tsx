import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { explainFailure, isFailureCode, statusColor } from "@sentinel/shared";
import { LatencyChart, RegionMap } from "@/components/charts";
import { budgetRemainingLabel, budgetSubLabel, budgetTone } from "@/components/slo-status";
import { FailureBadge, RegionDots, StatusPill, UptimeBar, UptimeLegend, Waterfall } from "@/components/status";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, LinkButton, Separator, Stat } from "@/components/ui";
import { deleteMonitorAction, runNowAction, togglePauseAction } from "@/lib/actions/monitors";
import { requireOrg } from "@/lib/auth";
import { getCertificates, getDashboardMonitors, getIncidents, getLatencySeries, getMonitor, getRecentChecks, getRegionHealth } from "@/lib/queries";
import { listSlos } from "@/lib/slo-queries";
import { cn, formatBytes, formatDateTime, formatMs, formatPercent, humanDuration, relativeTime } from "@/lib/utils";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; window?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { org } = await requireOrg();
  const monitor = await getMonitor(org.id, id);
  return { title: monitor?.name ?? "Monitor" };
}

export const dynamic = "force-dynamic";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "checks", label: "Recent checks" },
  { key: "incidents", label: "Incidents" },
  { key: "ssl", label: "SSL & domain" },
] as const;

const WINDOWS = [
  { key: "6", label: "6h" },
  { key: "24", label: "24h" },
  { key: "168", label: "7d" },
  { key: "720", label: "30d" },
] as const;

export default async function MonitorDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "overview";
  const hours = WINDOWS.some((w) => w.key === sp.window) ? Number(sp.window) : 24;

  const { org } = await requireOrg();
  const monitor = await getMonitor(org.id, id);
  if (!monitor) notFound();

  const [series, checks, incidents, certs, slos, regionHealth, dashboardRows] = await Promise.all([
    getLatencySeries(monitor.id, hours),
    getRecentChecks(monitor.id, tab === "checks" ? 100 : 12),
    getIncidents(org.id, { monitorId: monitor.id, limit: 25 }),
    getCertificates(org.id, monitor.id),
    listSlos(org.id, monitor.id),
    getRegionHealth(),
    getDashboardMonitors(org.id),
  ]);

  const slo = slos[0];
  const row = dashboardRows.find((m) => m.id === monitor.id);
  const latest = checks[0];
  const openIncident = incidents.find((i) => i.resolvedAt === null);
  const failureInfo = openIncident?.primaryFailureCode && isFailureCode(openIncident.primaryFailureCode) ? explainFailure(openIncident.primaryFailureCode) : null;

  const mapRegions = regionHealth
    .filter((r) => monitor.regions.includes(r.code))
    .map((r) => {
      const dot = row?.regions.find((x) => x.regionCode === r.code);
      return {
        regionCode: r.code,
        city: r.city,
        country: r.country,
        lat: r.lat,
        lng: r.lng,
        ok: dot?.ok ?? null,
        latencyMs: dot?.latencyMs ?? null,
        quarantined: r.healthStatus === "quarantined",
      };
    });

  const tabHref = (key: string) => `/monitors/${monitor.id}?tab=${key}${sp.window ? `&window=${sp.window}` : ""}`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink-2">
        <ChevronLeft className="size-4" />
        Monitors
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{monitor.name}</h1>
            <StatusPill status={monitor.status} pulse={monitor.status === "DOWN" || monitor.status === "PARTIAL_OUTAGE"} />
            <Badge tone="neutral">{monitor.type.toUpperCase()}</Badge>
            {monitor.tags.map((t) => (
              <Badge key={t} tone="info">
                {t}
              </Badge>
            ))}
          </div>
          <p className="mt-1.5 break-all font-mono text-sm text-ink-3">{monitor.url}</p>
          <p className="mt-1 text-xs text-ink-3">
            {monitor.status === "PAUSED" ? "Paused" : `${monitor.status === "UP" ? "Up" : "In this state"} for ${humanDuration(monitor.since ?? monitor.createdAt, null)}`}
            {" · every "}
            {monitor.intervalSeconds < 60 ? `${monitor.intervalSeconds}s` : `${monitor.intervalSeconds / 60}m`}
            {" · "}
            {monitor.regions.length} regions · quorum {Math.max(1, Math.ceil(monitor.regions.length * monitor.quorumRatio))}/{monitor.regions.length}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={runNowAction.bind(null, monitor.id)}>
            <Button type="submit" variant="outline" size="sm">
              <RefreshCw className="size-4" />
              Run now
            </Button>
          </form>
          <form action={togglePauseAction.bind(null, monitor.id)}>
            <Button type="submit" variant="outline" size="sm">
              {monitor.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {monitor.paused ? "Resume" : "Pause"}
            </Button>
          </form>
          <LinkButton href={`/monitors/${monitor.id}/edit`} variant="secondary" size="sm">
            <Pencil className="size-4" />
            Edit
          </LinkButton>
          <form action={deleteMonitorAction.bind(null, monitor.id)}>
            <Button type="submit" variant="danger" size="sm">
              <Trash2 className="size-4" />
              Delete
            </Button>
          </form>
        </div>
      </header>

      {openIncident && failureInfo && (
        <Alert tone="danger" className="mt-5">
          <strong className="font-medium">{failureInfo.label}</strong> — {failureInfo.explanation}{" "}
          <span className="text-ink-2">{failureInfo.suggestedAction}</span>{" "}
          <Link href={`/incidents/${openIncident.id}`} className="underline underline-offset-2">
            View incident
          </Link>
        </Alert>
      )}

      <nav className="mt-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              tab === t.key ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {t.label}
            {t.key === "incidents" && incidents.length > 0 && <span className="tnum ml-1.5 text-ink-3">{incidents.length}</span>}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="mt-6 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="py-4">
                <Stat label="Uptime · 30d" value={row?.uptime30d == null ? "—" : `${formatPercent(row.uptime30d, 3)}`} sub="from hourly rollups" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <Stat label="Latest latency" value={monitor.lastLatencyMs == null ? "—" : formatMs(monitor.lastLatencyMs)} sub={monitor.lastCheckAt ? relativeTime(monitor.lastCheckAt) : "no checks yet"} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <Stat
                  label="Failing regions"
                  value={String(monitor.failingRegions.length)}
                  sub={monitor.failingRegions.length ? monitor.failingRegions.join(", ") : "all healthy"}
                  tone={monitor.failingRegions.length ? "down" : "up"}
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                {slo ? (
                  <Link href={`/slos/${monitor.id}`} className="block transition-opacity hover:opacity-80">
                    <Stat
                      label={`Error budget · ${slo.windowDays}d`}
                      value={budgetRemainingLabel(slo.budget)}
                      sub={`target ${formatPercent(slo.targetPercent, 3)} · ${budgetSubLabel(slo.budget, slo.windowDays)}`}
                      tone={budgetTone(slo.budget)}
                    />
                  </Link>
                ) : (
                  <Stat
                    label="Error budget"
                    value="—"
                    sub={
                      <Link href="/slos" className="underline underline-offset-2">
                        set an SLO
                      </Link>
                    }
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>90-day uptime</CardTitle>
            </CardHeader>
            <CardContent>
              <UptimeBar slots={row?.days ?? []} className="h-10" />
              <UptimeLegend days={90} className="mt-2" />
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Latency p95 by region</CardTitle>
                <div className="flex gap-1 rounded-lg border border-line bg-surface-2/60 p-0.5">
                  {WINDOWS.map((w) => (
                    <Link
                      key={w.key}
                      href={`/monitors/${monitor.id}?tab=${tab}&window=${w.key}`}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs transition-colors",
                        String(hours) === w.key ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2",
                      )}
                    >
                      {w.label}
                    </Link>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                <LatencyChart points={series} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Probe regions</CardTitle>
              </CardHeader>
              <CardContent>
                <RegionMap regions={mapRegions} />
                <div className="mt-3 space-y-1.5">
                  {mapRegions.map((r) => (
                    <div key={r.regionCode} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            r.ok === false ? "bg-down" : r.quarantined ? "bg-inconclusive" : r.ok === null ? "bg-line-strong" : "bg-up",
                          )}
                        />
                        <span className="text-ink-2">{r.city}</span>
                        {r.quarantined && <Badge tone="info">quarantined</Badge>}
                      </span>
                      <span className="tnum text-ink-3">{r.latencyMs == null ? "—" : formatMs(r.latencyMs)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {latest && (
            <Card>
              <CardHeader>
                <CardTitle>Request waterfall</CardTitle>
                <p className="text-sm text-ink-3">
                  Latest check from {mapRegions.find((r) => r.regionCode === latest.regionCode)?.city ?? latest.regionCode} ·{" "}
                  {formatDateTime(latest.checkedAt)}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <Waterfall timing={latest} />
                <Separator />
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-3">Status</dt>
                    <dd className="tnum mt-0.5 text-ink">{latest.statusCode ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-3">Size</dt>
                    <dd className="tnum mt-0.5 text-ink">{latest.responseSizeBytes == null ? "—" : formatBytes(latest.responseSizeBytes)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-3">Resolved IP</dt>
                    <dd className="mt-0.5 font-mono text-xs text-ink">{latest.resolvedIp ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-3">Total</dt>
                    <dd className="tnum mt-0.5 text-ink">{formatMs(latest.totalMs)}</dd>
                  </div>
                </dl>
                {latest.bodySnippet && (
                  <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                    {latest.bodySnippet.slice(0, 2000)}
                  </pre>
                )}
              </CardContent>
            </Card>
          )}

          {monitor.assertions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Assertions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {monitor.assertions.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 font-mono text-xs">
                    <Badge tone="neutral">{a.kind}</Badge>
                    {a.target && <span className="text-ink-2">{a.target}</span>}
                    <span className="text-ink-3">{a.operator.replace(/_/g, " ")}</span>
                    <span className="text-ink">{a.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {tab === "checks" && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Recent checks</CardTitle>
            <p className="text-sm text-ink-3">Raw results with full phase timing, newest first.</p>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-line text-left text-xs uppercase tracking-wide text-ink-3">
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Region</th>
                    <th className="px-4 py-2 font-medium">Result</th>
                    <th className="px-4 py-2 text-right font-medium">DNS</th>
                    <th className="px-4 py-2 text-right font-medium">TCP</th>
                    <th className="px-4 py-2 text-right font-medium">TLS</th>
                    <th className="px-4 py-2 text-right font-medium">TTFB</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.map((c) => (
                    <tr key={`${c.id}-${c.checkedAt.getTime()}`} className="border-b border-line/50 last:border-0 hover:bg-surface-2/50">
                      <td className="whitespace-nowrap px-4 py-2 text-ink-2">{formatDateTime(c.checkedAt)}</td>
                      <td className="px-4 py-2 font-mono text-xs uppercase text-ink-3">{c.regionCode}</td>
                      <td className="px-4 py-2">
                        {c.ok ? (
                          <span className="tnum text-up">{c.statusCode ?? "OK"}</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <FailureBadge
                              code={c.failureCode ?? "UNKNOWN"}
                              phase={c.failureCode && isFailureCode(c.failureCode) ? explainFailure(c.failureCode).phase : "policy"}
                            />
                            <span className="truncate text-xs text-ink-3">{c.errorDetail}</span>
                          </span>
                        )}
                      </td>
                      <td className="tnum px-4 py-2 text-right text-ink-3">{c.dnsMs == null ? "—" : formatMs(c.dnsMs)}</td>
                      <td className="tnum px-4 py-2 text-right text-ink-3">{c.tcpMs == null ? "—" : formatMs(c.tcpMs)}</td>
                      <td className="tnum px-4 py-2 text-right text-ink-3">{c.tlsMs == null ? "—" : formatMs(c.tlsMs)}</td>
                      <td className="tnum px-4 py-2 text-right text-ink-3">{c.ttfbMs == null ? "—" : formatMs(c.ttfbMs)}</td>
                      <td className="tnum px-4 py-2 text-right text-ink">{formatMs(c.totalMs)}</td>
                    </tr>
                  ))}
                  {checks.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-ink-3">
                        No checks recorded yet. The scheduler dispatches this monitor within {monitor.intervalSeconds}s.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "incidents" && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Incident history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {incidents.length === 0 && <p className="py-8 text-center text-sm text-ink-3">No incidents recorded for this monitor.</p>}
            {incidents.map((i) => (
              <Link
                key={i.id}
                href={`/incidents/${i.id}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition-colors hover:border-line-strong"
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: i.resolvedAt ? "#6b7280" : statusColor(i.severity === "down" ? "DOWN" : "PARTIAL_OUTAGE") }} />
                <span className="text-sm text-ink">{formatDateTime(i.startedAt)}</span>
                <Badge tone={i.resolvedAt ? "neutral" : "danger"}>{i.resolvedAt ? "resolved" : "open"}</Badge>
                {i.primaryFailureCode && isFailureCode(i.primaryFailureCode) && (
                  <FailureBadge code={i.primaryFailureCode} phase={explainFailure(i.primaryFailureCode).phase} />
                )}
                <span className="text-xs text-ink-3">{humanDuration(i.startedAt, i.resolvedAt)}</span>
                <span className="ml-auto text-xs text-ink-3">{i.affectedRegions.join(", ")}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === "ssl" && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Certificate &amp; domain</CardTitle>
          </CardHeader>
          <CardContent>
            {certs.length === 0 && <p className="py-8 text-center text-sm text-ink-3">No certificate data — this monitor is not HTTPS, or it has not been checked yet.</p>}
            {certs.map((c) => {
              const days = c.certExpiresAt ? Math.floor((c.certExpiresAt.getTime() - Date.now()) / 86_400_000) : null;
              const domainDays = c.domainExpiresAt ? Math.floor((c.domainExpiresAt.getTime() - Date.now()) / 86_400_000) : null;
              return (
                <div key={c.monitorId} className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-line bg-surface-2/40 p-4">
                    <p className="text-xs uppercase tracking-wide text-ink-3">TLS certificate</p>
                    <p className={cn("tnum mt-1 text-2xl font-semibold", days != null && days <= 7 ? "text-down" : days != null && days <= 30 ? "text-degraded" : "text-ink")}>
                      {days == null ? "—" : `${days} days`}
                    </p>
                    <p className="mt-1 text-sm text-ink-2">{c.certExpiresAt ? formatDateTime(c.certExpiresAt) : "unknown"}</p>
                    <p className="mt-2 text-xs text-ink-3">Issuer: {c.certIssuer ?? "—"}</p>
                    <p className="text-xs text-ink-3">Host: {c.host}</p>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-2/40 p-4">
                    <p className="text-xs uppercase tracking-wide text-ink-3">Domain registration</p>
                    <p className={cn("tnum mt-1 text-2xl font-semibold", domainDays != null && domainDays <= 30 ? "text-degraded" : "text-ink")}>
                      {domainDays == null ? "—" : `${domainDays} days`}
                    </p>
                    <p className="mt-1 text-sm text-ink-2">{c.domainExpiresAt ? formatDateTime(c.domainExpiresAt) : "unknown"}</p>
                    <p className="mt-2 text-xs text-ink-3">Registrar: {c.registrar ?? "—"}</p>
                    <p className="text-xs text-ink-3">Domain: {c.domain ?? "—"}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {row && (
        <div className="mt-6 flex items-center gap-3 text-xs text-ink-3">
          <span>Current region health:</span>
          <RegionDots regions={row.regions} />
        </div>
      )}
    </div>
  );
}
