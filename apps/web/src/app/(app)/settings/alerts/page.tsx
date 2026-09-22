import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";
import { sql as rawSql } from "@sentinel/db";
import { EscalationPolicyForm, EscalationStepForm, MaintenanceForm, PolicyMonitorsForm } from "@/components/alerting-forms";
import { MaintenanceList } from "@/components/maintenance-list";
import { ChannelForm } from "@/components/settings-forms";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { deleteEscalationPolicyAction, deleteEscalationStepAction } from "@/lib/actions/alerting";
import { deleteChannelAction } from "@/lib/actions/channels";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { listMaintenanceWindows } from "@/lib/maintenance";
import { hasRole } from "@/lib/rbac";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Alerting" };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { org } = await requireOrg();

  const [channels, policies, monitorRows, maintenance, deliveries] = await Promise.all([
    rawSql<{ id: string; name: string; kind: string; config: { to?: string; url?: string; secret?: string }; created_at: Date }[]>`
      SELECT id, name, kind::text AS kind, config, created_at
      FROM alert_channels WHERE organization_id = ${org.id} ORDER BY created_at
    `,
    rawSql<
      {
        id: string;
        name: string;
        steps: { id: string; orderIndex: number; afterMinutes: number; channels: string[] }[] | null;
        monitor_ids: string[];
      }[]
    >`
      SELECT p.id, p.name,
        (SELECT json_agg(json_build_object(
          'id', s.id, 'orderIndex', s.order_index, 'afterMinutes', s.after_minutes,
          'channels', (SELECT coalesce(array_agg(c.name), '{}') FROM alert_channels c WHERE c.id = ANY(s.channel_ids))
        ) ORDER BY s.order_index) FROM escalation_steps s WHERE s.policy_id = p.id) AS steps,
        (SELECT coalesce(array_agg(mp.monitor_id::text), '{}') FROM monitor_policies mp WHERE mp.policy_id = p.id) AS monitor_ids
      FROM escalation_policies p WHERE p.organization_id = ${org.id} ORDER BY p.created_at
    `,
    rawSql<{ id: string; name: string; covered: boolean }[]>`
      SELECT m.id, m.name,
        EXISTS (SELECT 1 FROM monitor_policies mp WHERE mp.monitor_id = m.id) AS covered
      FROM monitors m WHERE m.organization_id = ${org.id} ORDER BY m.name
    `,
    listMaintenanceWindows(org.id),
    rawSql<{ id: string; channel: string; kind: string; status: string; attempted_at: Date; monitor: string; error: string | null }[]>`
      SELECT d.id, c.name AS channel, d.kind, d.status::text AS status, d.attempted_at, m.name AS monitor, d.error
      FROM alert_deliveries d
      JOIN alert_channels c ON c.id = d.channel_id
      JOIN incidents i ON i.id = d.incident_id
      JOIN monitors m ON m.id = i.monitor_id
      WHERE m.organization_id = ${org.id}
      ORDER BY d.attempted_at DESC LIMIT 20
    `,
  ]);

  const options = monitorRows.map((m) => ({ id: m.id, name: m.name }));
  // The alert query inner-joins monitor_policies, so a monitor without one is
  // silently never paged on. That is invisible until an outage, so surface it here.
  const uncovered = monitorRows.filter((m) => !m.covered);
  const canManage = hasRole(org.role, "admin");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Alerting</h1>
      <p className="mt-1 text-sm text-ink-2">Where Sentinel sends the page, and in what order.</p>

      {uncovered.length > 0 && (
        <Alert tone="warn" className="mt-4">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {uncovered.length} {uncovered.length === 1 ? "monitor is" : "monitors are"} not attached to an escalation policy and
              will not page anyone when they go down: <span className="text-ink">{uncovered.map((m) => m.name).join(", ")}</span>
            </span>
          </span>
        </Alert>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Channels</CardTitle>
              <CardDescription>One alert per incident open, one on resolve — deduplicated in the database.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {channels.length === 0 && <p className="py-6 text-center text-sm text-ink-3">No channels yet.</p>}
              {channels.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <Badge tone={c.kind === "email" ? "info" : c.kind === "webhook" ? "warn" : "accent"}>{c.kind}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{c.name}</span>
                    <span className="block truncate font-mono text-xs text-ink-3">{c.config.to ?? c.config.url}</span>
                  </span>
                  {c.config.secret && <Badge tone="neutral">signed</Badge>}
                  <form action={deleteChannelAction.bind(null, c.id)}>
                    <Button type="submit" variant="ghost" size="sm">
                      Remove
                    </Button>
                  </form>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Escalation policies</CardTitle>
              <CardDescription>Unacknowledged incidents escalate to the next step automatically.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {policies.length === 0 && (
                <p className="py-6 text-center text-sm text-ink-3">
                  No escalation policies yet. Monitors only page you once they are attached to one.
                </p>
              )}
              {policies.map((p) => (
                <div key={p.id} className="rounded-lg border border-line bg-surface-2/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.name}</p>
                    <PolicyMonitorsForm csrf={<CsrfInput />} policyId={p.id} monitors={options} attached={p.monitor_ids} />
                    <form action={deleteEscalationPolicyAction.bind(null, p.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </div>
                  <ol className="mt-2 space-y-1.5">
                    {(p.steps ?? []).map((s) => (
                      <li key={s.id} className="flex items-center gap-2 text-xs text-ink-2">
                        <span className="tnum rounded bg-surface-3 px-1.5 py-0.5 text-ink-3">
                          {s.afterMinutes === 0 ? "immediately" : `+${s.afterMinutes}m`}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{s.channels.join(", ")}</span>
                        {s.orderIndex > 0 && (
                          <form action={deleteEscalationStepAction.bind(null, s.id)}>
                            <Button type="submit" variant="ghost" size="sm">
                              Remove
                            </Button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ol>
                  <div className="mt-2">
                    <EscalationStepForm csrf={<CsrfInput />} policyId={p.id} channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <MaintenanceList windows={maintenance} canManage={canManage} />

          <Card>
            <CardHeader>
              <CardTitle>Recent deliveries</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <table className="w-full text-sm">
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id} className="border-b border-line/50 last:border-0">
                      <td className="px-4 py-2 text-ink-2">{d.monitor}</td>
                      <td className="px-4 py-2 text-ink-3">{d.channel}</td>
                      <td className="px-4 py-2">
                        <Badge tone={d.status === "sent" ? "accent" : d.status === "failed" ? "danger" : "neutral"}>{d.kind}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-ink-3">{relativeTime(d.attempted_at)}</td>
                    </tr>
                  ))}
                  {deliveries.length === 0 && (
                    <tr>
                      <td className="px-4 py-8 text-center text-sm text-ink-3">No alerts delivered yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <ChannelForm csrf={<CsrfInput />} />
          <EscalationPolicyForm csrf={<CsrfInput />} channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
          <MaintenanceForm csrf={<CsrfInput />} monitors={options} />
        </div>
      </div>
    </div>
  );
}
