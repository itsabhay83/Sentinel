/**
 * Read side for SLOs.
 *
 * Availability comes from the rollup tables, never from the partitioned `checks`
 * table: a 90-day SLO window would otherwise scan three partitions of raw rows
 * that the retention job may already have dropped. The 1h rollups are derived
 * from the 5m rollups, which makes their latency percentiles percentiles-of-
 * percentiles — but `count` and `ok_count` are plain sums at every level, so the
 * availability ratio this module computes is exact.
 *
 * Every query filters on `monitors.organization_id`; `slos` has no tenant column
 * of its own, so the join through `monitors` is the tenant scope.
 */
import "server-only";

import { sql as rawSql } from "@sentinel/db";
import type { MonitorStatus } from "@sentinel/shared";

import type { UptimeDay } from "@/lib/queries";
import { computeBudget, type ErrorBudget } from "@/lib/slo";

/** postgres.js hands back `sum()` as a decimal string, never a number. */
function count(value: string | null): number {
  return value === null ? 0 : Number(value);
}

type WindowCounts = { total: string | null; failed: string | null };

type SloRow = {
  id: string;
  name: string;
  paused: boolean;
  status: MonitorStatus | null;
  target_percent: string;
  window_days: number;
} & { window_total: string | null; window_failed: string | null };

export type SloSummary = {
  monitorId: string;
  monitorName: string;
  status: MonitorStatus;
  targetPercent: number;
  windowDays: number;
  totalChecks: number;
  failedChecks: number;
  budget: ErrorBudget;
};

function toSummary(row: SloRow): SloSummary {
  const totalChecks = count(row.window_total);
  const failedChecks = count(row.window_failed);
  const targetPercent = Number(row.target_percent);
  return {
    monitorId: row.id,
    monitorName: row.name,
    status: row.paused ? "PAUSED" : (row.status ?? "PENDING"),
    targetPercent,
    windowDays: row.window_days,
    totalChecks,
    failedChecks,
    budget: computeBudget(targetPercent, totalChecks, failedChecks),
  };
}

/**
 * The monitor filter is a parameter compared inside a static predicate rather
 * than an interpolated `AND` fragment. A dynamic fragment would make the
 * statement unpreparable, and postgres.js then returns every column as text —
 * `paused` would arrive as the string "false", which is truthy.
 */
export async function listSlos(organizationId: string, monitorId?: string): Promise<SloSummary[]> {
  const monitorFilter = monitorId ?? null;
  const rows = await rawSql<SloRow[]>`
    SELECT m.id, m.name, m.paused, st.status::text AS status,
           s.target_percent, s.window_days,
           w.total AS window_total, w.failed AS window_failed
    FROM slos s
    JOIN monitors m ON m.id = s.monitor_id
    LEFT JOIN monitor_state st ON st.monitor_id = m.id
    LEFT JOIN LATERAL (
      SELECT sum(r.count)::bigint AS total, (sum(r.count) - sum(r.ok_count))::bigint AS failed
      FROM check_rollups_1h r
      WHERE r.monitor_id = m.id AND r.bucket >= now() - make_interval(days => s.window_days)
    ) w ON true
    WHERE m.organization_id = ${organizationId}
      AND (${monitorFilter}::uuid IS NULL OR m.id = ${monitorFilter}::uuid)
    ORDER BY m.name
  `;
  return rows.map(toSummary);
}

export type SloDetail = SloSummary & {
  monitorUrl: string;
  intervalSeconds: number;
  /** Short-horizon burn, the signal that a budget is being spent right now. */
  burn1h: ErrorBudget;
  burn6h: ErrorBudget;
  days: UptimeDay[];
};

type SloDetailRow = SloRow & {
  url: string;
  interval_seconds: number;
  h1_total: string | null;
  h1_failed: string | null;
  h6_total: string | null;
  h6_failed: string | null;
};

export async function getSloDetail(
  organizationId: string,
  monitorId: string,
): Promise<SloDetail | null> {
  const [row] = await rawSql<SloDetailRow[]>`
    SELECT m.id, m.name, m.url, m.interval_seconds, m.paused,
           st.status::text AS status, s.target_percent, s.window_days,
           w.total AS window_total, w.failed AS window_failed,
           h1.total AS h1_total, h1.failed AS h1_failed,
           h6.total AS h6_total, h6.failed AS h6_failed
    FROM slos s
    JOIN monitors m ON m.id = s.monitor_id
    LEFT JOIN monitor_state st ON st.monitor_id = m.id
    LEFT JOIN LATERAL (
      SELECT sum(r.count)::bigint AS total, (sum(r.count) - sum(r.ok_count))::bigint AS failed
      FROM check_rollups_1h r
      WHERE r.monitor_id = m.id AND r.bucket >= now() - make_interval(days => s.window_days)
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT sum(r.count)::bigint AS total, (sum(r.count) - sum(r.ok_count))::bigint AS failed
      FROM check_rollups_5m r
      WHERE r.monitor_id = m.id AND r.bucket >= now() - interval '1 hour'
    ) h1 ON true
    LEFT JOIN LATERAL (
      SELECT sum(r.count)::bigint AS total, (sum(r.count) - sum(r.ok_count))::bigint AS failed
      FROM check_rollups_5m r
      WHERE r.monitor_id = m.id AND r.bucket >= now() - interval '6 hours'
    ) h6 ON true
    WHERE m.organization_id = ${organizationId} AND m.id = ${monitorId}
  `;
  if (!row) return null;

  const summary = toSummary(row);
  const shortBurn = ({ total, failed }: WindowCounts): ErrorBudget =>
    computeBudget(summary.targetPercent, count(total), count(failed));

  return {
    ...summary,
    monitorUrl: row.url,
    intervalSeconds: row.interval_seconds,
    burn1h: shortBurn({ total: row.h1_total, failed: row.h1_failed }),
    burn6h: shortBurn({ total: row.h6_total, failed: row.h6_failed }),
    days: await dailyAvailability(monitorId, summary.windowDays),
  };
}

/** `p95_ms` is deliberately unselected here: in the 1h rollups it is a max over 5m p95s, i.e. approximate. */
async function dailyAvailability(monitorId: string, windowDays: number): Promise<UptimeDay[]> {
  const rows = await rawSql<{ day: string; total: number; ok: number }[]>`
    SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day,
           sum(count)::int AS total, sum(ok_count)::int AS ok
    FROM check_rollups_1h
    WHERE monitor_id = ${monitorId}
      AND bucket >= date_trunc('day', now()) - make_interval(days => ${windowDays - 1})
    GROUP BY 1
  `;
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const slots: UptimeDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const hit = byDay.get(day);
    slots.push({
      day,
      uptime: hit && hit.total > 0 ? hit.ok / hit.total : null,
      p95Ms: null,
    });
  }
  return slots;
}

export type SloCandidate = { id: string; name: string; hasSlo: boolean };

/** Every monitor in the org, flagged with whether an SLO already covers it. */
export async function listSloCandidates(organizationId: string): Promise<SloCandidate[]> {
  const rows = await rawSql<{ id: string; name: string; has_slo: boolean }[]>`
    SELECT m.id, m.name, EXISTS (SELECT 1 FROM slos s WHERE s.monitor_id = m.id) AS has_slo
    FROM monitors m
    WHERE m.organization_id = ${organizationId}
    ORDER BY m.name
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, hasSlo: r.has_slo }));
}
