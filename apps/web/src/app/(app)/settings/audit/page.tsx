import type { Metadata } from "next";
import { sql as rawSql } from "@sentinel/db";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, LinkButton, Select } from "@/components/ui";
import { AUDIT_ACTIONS, isAuditAction } from "@/lib/audit";
import { requireRole } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE = 1000;

type AuditRow = {
  id: string;
  action: string;
  actor_email: string | null;
  actor_name: string | null;
  actor_type: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  created_at: Date | string;
};

type Filters = { action: string | null; actor: string | null; page: number };

function readFilters(params: Record<string, string | string[] | undefined>): Filters {
  const action = typeof params.action === "string" && isAuditAction(params.action) ? params.action : null;
  const raw = typeof params.actor === "string" ? params.actor.trim() : "";
  const page = Math.min(MAX_PAGE, Math.max(1, Number(params.page) || 1));
  return { action, actor: raw.length > 0 && raw.length <= 320 ? raw : null, page };
}

function pageHref(filters: Filters, page: number): string {
  const query = new URLSearchParams();
  if (filters.action) query.set("action", filters.action);
  if (filters.actor) query.set("actor", filters.actor);
  query.set("page", String(page));
  return `/settings/audit?${query.toString()}`;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await requireRole("admin");
  const filters = readFilters(await searchParams);
  const offset = (filters.page - 1) * PAGE_SIZE;

  // One extra row answers "is there a next page?" without a second COUNT(*) over
  // a table that only ever grows.
  const [rows, actors] = await Promise.all([
    rawSql<AuditRow[]>`
      SELECT a.id, a.action, a.actor_email, a.actor_type, a.target_type, a.target_id, a.ip, a.created_at,
             u.name AS actor_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.organization_id = ${org.id}
        ${filters.action ? rawSql`AND a.action = ${filters.action}` : rawSql``}
        ${filters.actor ? rawSql`AND a.actor_email = ${filters.actor}` : rawSql``}
      ORDER BY a.created_at DESC
      LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}
    `,
    rawSql<{ actor_email: string }[]>`
      SELECT DISTINCT actor_email FROM audit_logs
      WHERE organization_id = ${org.id} AND actor_email IS NOT NULL
      ORDER BY actor_email LIMIT 200
    `,
  ]);

  const hasNext = rows.length > PAGE_SIZE;
  const entries = hasNext ? rows.slice(0, PAGE_SIZE) : rows;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-ink-2">
        Every change to this organization, newest first. Entries are append-only and outlive the accounts that made them.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <Field label="Action" htmlFor="filter-action" className="w-48">
              <Select id="filter-action" name="action" defaultValue={filters.action ?? ""} className="h-8 text-xs">
                <option value="">All actions</option>
                {AUDIT_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Actor" htmlFor="filter-actor" className="w-56">
              <Select id="filter-actor" name="actor" defaultValue={filters.actor ?? ""} className="h-8 text-xs">
                <option value="">Everyone</option>
                {actors.map((a) => (
                  <option key={a.actor_email} value={a.actor_email}>
                    {a.actor_email}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              Filter
            </Button>
          </form>
        </CardHeader>
        <CardContent className="space-y-2">
          {entries.length === 0 && <p className="py-6 text-center text-sm text-ink-3">Nothing recorded for these filters.</p>}
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
              <span className="tnum w-40 shrink-0 text-xs text-ink-3">{formatDateTime(entry.created_at)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{entry.actor_name ?? entry.actor_email ?? entry.actor_type}</span>
                <span className="block truncate font-mono text-xs text-ink-3">{entry.action}</span>
              </span>
              {entry.target_type && (
                <span className="min-w-0 max-w-56 truncate font-mono text-xs text-ink-3">
                  {entry.target_type}
                  {entry.target_id ? `:${entry.target_id.slice(0, 8)}` : ""}
                </span>
              )}
              <Badge tone="neutral">{entry.ip ?? "no ip"}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-ink-3">Page {filters.page}</p>
        <div className="flex gap-2">
          {filters.page > 1 && (
            <LinkButton href={pageHref(filters, filters.page - 1)} variant="ghost" size="sm">
              Previous
            </LinkButton>
          )}
          {hasNext && (
            <LinkButton href={pageHref(filters, filters.page + 1)} variant="ghost" size="sm">
              Next
            </LinkButton>
          )}
        </div>
      </div>
    </div>
  );
}
