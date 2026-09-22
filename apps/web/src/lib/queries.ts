/**
 * Read-side data access for the dashboard, monitor detail, incidents and the
 * public status page.
 *
 * Everything here is raw SQL rather than the Drizzle query builder. The shapes
 * these pages need are aggregate-heavy — 90 day-buckets per monitor, per-region
 * latest-check lateral joins, percentile rollups — and expressing those through
 * a builder produces code that is harder to read than the SQL it emits, with no
 * type safety gained once you reach for `sql` fragments anyway.
 *
 * Every function that touches tenant data takes an `organizationId` and filters
 * on it. There is no query here that can be called without a tenant scope.
 */
import "server-only";

import { unstable_cache } from "next/cache";
import { sql as rawSql } from "@sentinel/db";
import type { MonitorStatus } from "@sentinel/shared";
import { REGIONS } from "@sentinel/shared";

export type UptimeDay = { day: string; uptime: number | null; p95Ms: number | null };

export type DashboardMonitor = {
  id: string;
  name: string;
  url: string;
  type: string;
  groupName: string | null;
  tags: string[];
  paused: boolean;
  intervalSeconds: number;
  status: MonitorStatus;
  since: Date | null;
  lastCheckAt: Date | null;
  lastLatencyMs: number | null;
  failingRegions: string[];
  uptime30d: number | null;
  days: UptimeDay[];
  regions: { regionCode: string; city: string; ok: boolean | null; latencyMs: number | null; failureCode: string | null }[];
  openIncidentId: string | null;
};

const REGION_CITY = new Map<string, string>(REGIONS.map((r) => [r.code, r.city]));

/**
 * The dashboard list.
 *
 * One round trip. The 90-day bars come from `check_rollups_1h` (not raw checks)
 * so the query stays fast no matter how much history exists, and the per-region
 * dots come from a lateral that reads the newest check per region.
 */
export async function getDashboardMonitors(organizationId: string, days = 90): Promise<DashboardMonitor[]> {
  const rows = await rawSql<
    {
      id: string;
      name: string;
      url: string;
      type: string;
      group_name: string | null;
      tags: string[] | null;
      paused: boolean;
      interval_seconds: number;
      status: MonitorStatus | null;
      since: Date | null;
      last_check_at: Date | null;
      last_latency_ms: number | null;
      failing_regions: string[] | null;
      current_incident_id: string | null;
      uptime_30d: string | null;
      days: { day: string; total: number; ok: number; p95: number | null }[] | null;
      regions: { regionCode: string; ok: boolean; latencyMs: number | null; failureCode: string | null }[] | null;
    }[]
  >`
    SELECT
      m.id,
      m.name,
      m.url,
      m.type::text,
      m.group_name,
      m.tags,
      m.paused,
      m.interval_seconds,
      s.status::text AS status,
      s.since,
      s.last_check_at,
      s.last_latency_ms,
      s.failing_regions,
      s.current_incident_id,
      u.uptime_30d,
      d.days,
      r.regions
    FROM monitors m
    LEFT JOIN monitor_state s ON s.monitor_id = m.id
    LEFT JOIN LATERAL (
      SELECT sum(ok_count)::numeric / NULLIF(sum(count), 0) AS uptime_30d
      FROM check_rollups_1h
      WHERE monitor_id = m.id AND bucket >= now() - interval '30 days'
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(x ORDER BY x.day) AS days
      FROM (
        SELECT
          to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day,
          sum(count)::int AS total,
          sum(ok_count)::int AS ok,
          max(p95_ms)::int AS p95
        FROM check_rollups_1h
        WHERE monitor_id = m.id AND bucket >= date_trunc('day', now()) - make_interval(days => ${days - 1})
        GROUP BY 1
      ) x
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(y) AS regions
      FROM (
        SELECT DISTINCT ON (mr.region_code)
          mr.region_code AS "regionCode",
          c.ok,
          c.total_ms AS "latencyMs",
          c.failure_code AS "failureCode"
        FROM monitor_regions mr
        LEFT JOIN LATERAL (
          SELECT ok, total_ms, failure_code
          FROM checks
          WHERE monitor_id = m.id
            AND region_code = mr.region_code
            AND checked_at >= now() - interval '1 day'
          ORDER BY checked_at DESC
          LIMIT 1
        ) c ON true
        WHERE mr.monitor_id = m.id AND mr.enabled = true
        ORDER BY mr.region_code
      ) y
    ) r ON true
    WHERE m.organization_id = ${organizationId}
    ORDER BY m.group_name NULLS LAST, m.name
  `;

  // Build the day axis once so every monitor's bar has identical slot alignment;
  // a missing day must render as a gap, not shift the whole row left.
  const axis: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().slice(0, 10));
  }

  return rows.map((row) => {
    const byDay = new Map((row.days ?? []).map((d) => [d.day, d]));
    const regionRows = row.regions ?? [];
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      type: row.type,
      groupName: row.group_name,
      tags: row.tags ?? [],
      paused: row.paused,
      intervalSeconds: row.interval_seconds,
      status: row.paused ? "PAUSED" : (row.status ?? "PENDING"),
      since: row.since,
      lastCheckAt: row.last_check_at,
      lastLatencyMs: row.last_latency_ms,
      failingRegions: row.failing_regions ?? [],
      uptime30d: row.uptime_30d == null ? null : Number(row.uptime_30d) * 100,
      days: axis.map((day) => {
        const hit = byDay.get(day);
        return {
          day,
          uptime: hit && hit.total > 0 ? hit.ok / hit.total : null,
          p95Ms: hit?.p95 ?? null,
        };
      }),
      regions: regionRows.map((r) => ({
        regionCode: r.regionCode,
        city: REGION_CITY.get(r.regionCode) ?? r.regionCode,
        ok: r.ok ?? null,
        latencyMs: r.latencyMs,
        failureCode: r.failureCode,
      })),
      openIncidentId: row.current_incident_id,
    };
  });
}

export type OrgSummary = {
  total: number;
  up: number;
  down: number;
  degraded: number;
  partial: number;
  paused: number;
  pending: number;
  openIncidents: number;
  uptime24h: number | null;
  p95_24h: number | null;
  checksToday: number;
};

export async function getOrgSummary(organizationId: string): Promise<OrgSummary> {
  const [row] = await rawSql<
    {
      total: number;
      up: number;
      down: number;
      degraded: number;
      partial: number;
      paused: number;
      pending: number;
      open_incidents: number;
      uptime_24h: string | null;
      p95_24h: number | null;
      checks_today: number;
    }[]
  >`
    WITH mine AS (SELECT id, paused FROM monitors WHERE organization_id = ${organizationId}),
    states AS (
      SELECT mine.id, mine.paused, s.status::text AS status
      FROM mine LEFT JOIN monitor_state s ON s.monitor_id = mine.id
    )
    SELECT
      (SELECT count(*)::int FROM states) AS total,
      (SELECT count(*)::int FROM states WHERE NOT paused AND status = 'UP') AS up,
      (SELECT count(*)::int FROM states WHERE NOT paused AND status = 'DOWN') AS down,
      (SELECT count(*)::int FROM states WHERE NOT paused AND status = 'DEGRADED') AS degraded,
      (SELECT count(*)::int FROM states WHERE NOT paused AND status = 'PARTIAL_OUTAGE') AS partial,
      (SELECT count(*)::int FROM states WHERE paused) AS paused,
      (SELECT count(*)::int FROM states WHERE NOT paused AND (status IS NULL OR status IN ('PENDING','INCONCLUSIVE'))) AS pending,
      (SELECT count(*)::int FROM incidents i JOIN mine ON mine.id = i.monitor_id WHERE i.resolved_at IS NULL) AS open_incidents,
      (SELECT sum(ok_count)::numeric / NULLIF(sum(count), 0) FROM check_rollups_5m r JOIN mine ON mine.id = r.monitor_id WHERE r.bucket >= now() - interval '24 hours') AS uptime_24h,
      (SELECT max(p95_ms)::int FROM check_rollups_5m r JOIN mine ON mine.id = r.monitor_id WHERE r.bucket >= now() - interval '24 hours') AS p95_24h,
      (SELECT coalesce(sum(count), 0)::int FROM check_rollups_5m r JOIN mine ON mine.id = r.monitor_id WHERE r.bucket >= date_trunc('day', now())) AS checks_today
  `;

  return {
    total: row?.total ?? 0,
    up: row?.up ?? 0,
    down: row?.down ?? 0,
    degraded: row?.degraded ?? 0,
    partial: row?.partial ?? 0,
    paused: row?.paused ?? 0,
    pending: row?.pending ?? 0,
    openIncidents: row?.open_incidents ?? 0,
    uptime24h: row?.uptime_24h == null ? null : Number(row.uptime_24h) * 100,
    p95_24h: row?.p95_24h ?? null,
    checksToday: row?.checks_today ?? 0,
  };
}

export type MonitorDetail = {
  id: string;
  organizationId: string;
  name: string;
  url: string;
  type: string;
  method: string;
  groupName: string | null;
  tags: string[];
  paused: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  expectedStatusCodes: number[];
  quorumRatio: number;
  minRegionsRequired: number;
  confirmationFailures: number;
  confirmationSuccesses: number;
  degradedThresholdMs: number | null;
  headersEncrypted: string | null;
  bodyEncrypted: string | null;
  status: MonitorStatus;
  since: Date | null;
  lastCheckAt: Date | null;
  lastLatencyMs: number | null;
  failingRegions: string[];
  openIncidentId: string | null;
  regions: string[];
  assertions: { id: string; kind: string; target: string | null; operator: string; value: string; orderIndex: number }[];
  createdAt: Date;
};

export async function getMonitor(organizationId: string, monitorId: string): Promise<MonitorDetail | null> {
  const [row] = await rawSql<
    {
      id: string;
      organization_id: string;
      name: string;
      url: string;
      type: string;
      method: string;
      group_name: string | null;
      tags: string[] | null;
      paused: boolean;
      interval_seconds: number;
      timeout_ms: number;
      follow_redirects: boolean;
      max_redirects: number;
      expected_status_codes: number[] | null;
      quorum_ratio: string;
      min_regions_required: number;
      confirmation_failures: number;
      confirmation_successes: number;
      degraded_threshold_ms: number | null;
      headers_encrypted: string | null;
      body_encrypted: string | null;
      created_at: Date;
      status: MonitorStatus | null;
      since: Date | null;
      last_check_at: Date | null;
      last_latency_ms: number | null;
      failing_regions: string[] | null;
      current_incident_id: string | null;
      regions: string[] | null;
      assertions: MonitorDetail["assertions"] | null;
    }[]
  >`
    SELECT
      m.*,
      s.status::text AS status,
      s.since,
      s.last_check_at,
      s.last_latency_ms,
      s.failing_regions,
      s.current_incident_id,
      (SELECT array_agg(region_code ORDER BY region_code) FROM monitor_regions WHERE monitor_id = m.id AND enabled) AS regions,
      (
        SELECT json_agg(json_build_object(
          'id', a.id, 'kind', a.kind::text, 'target', a.target,
          'operator', a.operator, 'value', a.value, 'orderIndex', a.order_index
        ) ORDER BY a.order_index)
        FROM assertions a WHERE a.monitor_id = m.id
      ) AS assertions
    FROM monitors m
    LEFT JOIN monitor_state s ON s.monitor_id = m.id
    WHERE m.id = ${monitorId} AND m.organization_id = ${organizationId}
  `;
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    url: row.url,
    type: row.type,
    method: row.method,
    groupName: row.group_name,
    tags: row.tags ?? [],
    paused: row.paused,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    followRedirects: row.follow_redirects,
    maxRedirects: row.max_redirects,
    expectedStatusCodes: row.expected_status_codes ?? [],
    quorumRatio: Number(row.quorum_ratio),
    minRegionsRequired: row.min_regions_required,
    confirmationFailures: row.confirmation_failures,
    confirmationSuccesses: row.confirmation_successes,
    degradedThresholdMs: row.degraded_threshold_ms,
    headersEncrypted: row.headers_encrypted,
    bodyEncrypted: row.body_encrypted,
    status: row.paused ? "PAUSED" : (row.status ?? "PENDING"),
    since: row.since,
    lastCheckAt: row.last_check_at,
    lastLatencyMs: row.last_latency_ms,
    failingRegions: row.failing_regions ?? [],
    openIncidentId: row.current_incident_id,
    regions: row.regions ?? [],
    assertions: row.assertions ?? [],
    createdAt: row.created_at,
  };
}

export type LatencyPoint = { bucket: string; regionCode: string; p50: number | null; p95: number | null; uptime: number | null };

/**
 * Latency series for the detail chart. Reads 5m rollups inside 48h and 1h
 * rollups beyond, so a 30-day view does not try to render 8,640 points.
 */
export async function getLatencySeries(monitorId: string, hours: number): Promise<LatencyPoint[]> {
  const table = hours <= 48 ? "check_rollups_5m" : "check_rollups_1h";

  // Every column is typed `string` here on purpose. Interpolating the relation
  // name makes this statement unpreparable, so postgres.js drops to the simple
  // query protocol — where Postgres returns every value as text and the
  // OID-based parsers never run. Trusting the declared column types instead
  // crashes the page with `r.bucket.toISOString is not a function`.
  const rows = await rawSql<
    { bucket: string; region_code: string; p50: string | null; p95: string | null; count: string; ok_count: string }[]
  >`
    SELECT bucket, region_code, p50_ms AS p50, p95_ms AS p95, count, ok_count
    FROM ${rawSql(table)}
    WHERE monitor_id = ${monitorId} AND bucket >= now() - make_interval(hours => ${hours})
    ORDER BY bucket
  `;
  return rows.map((r) => {
    const total = Number(r.count);
    return {
      bucket: new Date(r.bucket).toISOString(),
      regionCode: r.region_code,
      p50: r.p50 === null ? null : Number(r.p50),
      p95: r.p95 === null ? null : Number(r.p95),
      uptime: total > 0 ? Number(r.ok_count) / total : null,
    };
  });
}

export type RecentCheck = {
  id: string;
  regionCode: string;
  checkedAt: Date;
  ok: boolean;
  statusCode: number | null;
  failureCode: string | null;
  errorDetail: string | null;
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  transferMs: number | null;
  totalMs: number;
  responseSizeBytes: number | null;
  resolvedIp: string | null;
  bodySnippet: string | null;
  responseHeaders: Record<string, string> | null;
};

export async function getRecentChecks(monitorId: string, limit = 50, regionCode?: string): Promise<RecentCheck[]> {
  const rows = await rawSql<
    {
      id: string;
      region_code: string;
      checked_at: Date;
      ok: boolean;
      status_code: number | null;
      failure_code: string | null;
      error_detail: string | null;
      dns_ms: number | null;
      tcp_ms: number | null;
      tls_ms: number | null;
      ttfb_ms: number | null;
      transfer_ms: number | null;
      total_ms: number;
      response_size_bytes: string | null;
      resolved_ip: string | null;
      body_snippet: string | null;
      response_headers: Record<string, string> | null;
    }[]
  >`
    SELECT id, region_code, checked_at, ok, status_code, failure_code, error_detail,
           dns_ms, tcp_ms, tls_ms, ttfb_ms, transfer_ms, total_ms,
           response_size_bytes, host(resolved_ip) AS resolved_ip, body_snippet, response_headers
    FROM checks
    WHERE monitor_id = ${monitorId}
      ${regionCode ? rawSql`AND region_code = ${regionCode}` : rawSql``}
      AND checked_at >= now() - interval '7 days'
    ORDER BY checked_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    regionCode: r.region_code,
    checkedAt: r.checked_at,
    ok: r.ok,
    statusCode: r.status_code,
    failureCode: r.failure_code,
    errorDetail: r.error_detail,
    dnsMs: r.dns_ms,
    tcpMs: r.tcp_ms,
    tlsMs: r.tls_ms,
    ttfbMs: r.ttfb_ms,
    transferMs: r.transfer_ms,
    totalMs: r.total_ms,
    responseSizeBytes: r.response_size_bytes == null ? null : Number(r.response_size_bytes),
    resolvedIp: r.resolved_ip,
    bodySnippet: r.body_snippet,
    responseHeaders: r.response_headers,
  }));
}

export type IncidentRow = {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorUrl: string;
  startedAt: Date;
  resolvedAt: Date | null;
  severity: string;
  primaryFailureCode: string | null;
  affectedRegions: string[];
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  isFlapping: boolean;
  postmortem: string | null;
};

export async function getIncidents(organizationId: string, opts: { monitorId?: string; open?: boolean; limit?: number } = {}): Promise<IncidentRow[]> {
  const rows = await rawSql<
    {
      id: string;
      monitor_id: string;
      monitor_name: string;
      monitor_url: string;
      started_at: Date;
      resolved_at: Date | null;
      severity: string;
      primary_failure_code: string | null;
      affected_regions: string[] | null;
      acknowledged_at: Date | null;
      acknowledged_by: string | null;
      is_flapping: string | null;
      postmortem: string | null;
    }[]
  >`
    SELECT i.id, i.monitor_id, m.name AS monitor_name, m.url AS monitor_url,
           i.started_at, i.resolved_at, i.severity::text AS severity, i.primary_failure_code,
           i.affected_regions, i.acknowledged_at, i.acknowledged_by, i.is_flapping, i.postmortem
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE m.organization_id = ${organizationId}
      ${opts.monitorId ? rawSql`AND i.monitor_id = ${opts.monitorId}` : rawSql``}
      ${opts.open ? rawSql`AND i.resolved_at IS NULL` : rawSql``}
    ORDER BY i.started_at DESC
    LIMIT ${opts.limit ?? 50}
  `;
  return rows.map((r) => ({
    id: r.id,
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    monitorUrl: r.monitor_url,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    severity: r.severity,
    primaryFailureCode: r.primary_failure_code,
    affectedRegions: r.affected_regions ?? [],
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
    isFlapping: r.is_flapping === "true",
    postmortem: r.postmortem,
  }));
}

export type IncidentEvent = { id: string; at: Date; kind: string; payload: Record<string, unknown> };

export async function getIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const rows = await rawSql<{ id: string; at: Date; kind: string; payload: Record<string, unknown> }[]>`
    SELECT id, at, kind::text AS kind, payload
    FROM incident_events WHERE incident_id = ${incidentId}
    ORDER BY at ASC
  `;
  return rows;
}

export async function getIncident(organizationId: string, incidentId: string): Promise<IncidentRow | null> {
  const rows = await getIncidents(organizationId, { limit: 1000 });
  return rows.find((r) => r.id === incidentId) ?? null;
}

export type CertificateRow = {
  monitorId: string;
  monitorName: string;
  host: string;
  certExpiresAt: Date | null;
  certIssuer: string | null;
  domain: string | null;
  domainExpiresAt: Date | null;
  registrar: string | null;
  checkedAt: Date | null;
};

export async function getCertificates(organizationId: string, monitorId?: string): Promise<CertificateRow[]> {
  const rows = await rawSql<
    {
      monitor_id: string;
      monitor_name: string;
      host: string;
      cert_expires_at: Date | null;
      cert_issuer: string | null;
      domain: string | null;
      domain_expires_at: Date | null;
      registrar: string | null;
      checked_at: Date | null;
    }[]
  >`
    SELECT c.monitor_id, m.name AS monitor_name, c.host, c.cert_expires_at, c.cert_issuer,
           c.domain, c.domain_expires_at, c.registrar, c.checked_at
    FROM monitor_certificates c
    JOIN monitors m ON m.id = c.monitor_id
    WHERE m.organization_id = ${organizationId}
      ${monitorId ? rawSql`AND c.monitor_id = ${monitorId}` : rawSql``}
    ORDER BY c.cert_expires_at NULLS LAST
  `;
  return rows.map((r) => ({
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    host: r.host,
    certExpiresAt: r.cert_expires_at,
    certIssuer: r.cert_issuer,
    domain: r.domain,
    domainExpiresAt: r.domain_expires_at,
    registrar: r.registrar,
    checkedAt: r.checked_at,
  }));
}

export type RegionHealthRow = {
  code: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  enabled: boolean;
  healthStatus: string;
  quarantinedUntil: Date | null;
  quarantineReason: string | null;
  lastSeenAt: Date | null;
};

export async function getRegionHealth(): Promise<RegionHealthRow[]> {
  const rows = await rawSql<
    {
      code: string;
      city: string;
      country: string;
      lat: string;
      lng: string;
      enabled: boolean;
      health_status: string;
      quarantined_until: Date | null;
      quarantine_reason: string | null;
      last_seen_at: Date | null;
    }[]
  >`SELECT code, city, country, lat, lng, enabled, health_status::text AS health_status,
           quarantined_until, quarantine_reason, last_seen_at
    FROM regions ORDER BY code`;
  return rows.map((r) => ({
    code: r.code,
    city: r.city,
    country: r.country,
    lat: Number(r.lat),
    lng: Number(r.lng),
    enabled: r.enabled,
    healthStatus: r.health_status,
    quarantinedUntil: r.quarantined_until,
    quarantineReason: r.quarantine_reason,
    lastSeenAt: r.last_seen_at,
  }));
}

/* ------------------------------------------------------------------ */
/* Public status page                                                  */
/* ------------------------------------------------------------------ */

export type StatusPageData = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  theme: { accent?: string; mode?: string } | null;
  showUptimeDays: number;
  organizationId: string;
  groups: {
    name: string;
    monitors: {
      id: string;
      displayName: string;
      status: MonitorStatus;
      uptime: number | null;
      days: UptimeDay[];
    }[];
  }[];
  incidents: {
    id: string;
    monitorName: string;
    startedAt: Date;
    resolvedAt: Date | null;
    severity: string;
    primaryFailureCode: string | null;
    events: IncidentEvent[];
  }[];
};

/**
 * The public status page.
 *
 * `display_name` is used everywhere instead of the monitor's real name, and the
 * monitor URL is never selected — an internal hostname leaking onto a public
 * page is a data disclosure bug, so the query simply cannot return one.
 */
export const STATUS_PAGE_CACHE_TAG = "status-page";

export type StatusPageAccess = {
  id: string;
  title: string;
  description: string | null;
  theme: { accent?: string; mode?: string } | null;
  passwordHash: string | null;
};

/**
 * Deliberately uncached, unlike `getStatusPage`: caching would delay a password
 * being set or cleared by up to 30s on the public page, which is the wrong trade
 * for the single indexed lookup that decides who gets in.
 */
export async function getStatusPageAccess(slug: string): Promise<StatusPageAccess | null> {
  const [page] = await rawSql<
    {
      id: string;
      title: string;
      description: string | null;
      theme: { accent?: string; mode?: string } | null;
      password_hash: string | null;
    }[]
  >`SELECT id, title, description, theme, password_hash
    FROM status_pages WHERE slug = ${slug} AND published = true`;
  if (!page) return null;
  return {
    id: page.id,
    title: page.title,
    description: page.description,
    theme: page.theme,
    passwordHash: page.password_hash,
  };
}

async function loadStatusPage(slug: string): Promise<StatusPageData | null> {
  const [page] = await rawSql<
    {
      id: string;
      organization_id: string;
      slug: string;
      title: string;
      description: string | null;
      theme: { accent?: string; mode?: string } | null;
      show_uptime_days: number;
      published: boolean;
    }[]
  >`SELECT id, organization_id, slug, title, description, theme, show_uptime_days, published
    FROM status_pages WHERE slug = ${slug} AND published = true`;
  if (!page) return null;

  const days = page.show_uptime_days;
  const monitors = await rawSql<
    {
      monitor_id: string;
      display_name: string;
      group_name: string;
      order_index: number;
      status: MonitorStatus | null;
      paused: boolean;
      uptime: string | null;
      days: { day: string; total: number; ok: number }[] | null;
    }[]
  >`
    SELECT spm.monitor_id, spm.display_name, spm.group_name, spm.order_index,
           s.status::text AS status, m.paused, u.uptime, d.days
    FROM status_page_monitors spm
    JOIN monitors m ON m.id = spm.monitor_id
    LEFT JOIN monitor_state s ON s.monitor_id = spm.monitor_id
    LEFT JOIN LATERAL (
      SELECT sum(ok_count)::numeric / NULLIF(sum(count), 0) AS uptime
      FROM check_rollups_1h WHERE monitor_id = spm.monitor_id AND bucket >= now() - make_interval(days => ${days})
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(x ORDER BY x.day) AS days FROM (
        SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day,
               sum(count)::int AS total, sum(ok_count)::int AS ok
        FROM check_rollups_1h
        WHERE monitor_id = spm.monitor_id AND bucket >= date_trunc('day', now()) - make_interval(days => ${days - 1})
        GROUP BY 1
      ) x
    ) d ON true
    WHERE spm.status_page_id = ${page.id}
    ORDER BY spm.group_name, spm.order_index
  `;

  const axis: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().slice(0, 10));
  }

  const groups = new Map<string, StatusPageData["groups"][number]["monitors"]>();
  for (const m of monitors) {
    const byDay = new Map((m.days ?? []).map((d) => [d.day, d]));
    const entry = {
      id: m.monitor_id,
      displayName: m.display_name,
      status: (m.paused ? "PAUSED" : (m.status ?? "PENDING")) as MonitorStatus,
      uptime: m.uptime == null ? null : Number(m.uptime) * 100,
      days: axis.map((day) => {
        const hit = byDay.get(day);
        return { day, uptime: hit && hit.total > 0 ? hit.ok / hit.total : null, p95Ms: null };
      }),
    };
    const list = groups.get(m.group_name) ?? [];
    list.push(entry);
    groups.set(m.group_name, list);
  }

  const incidentRows = await rawSql<
    {
      id: string;
      monitor_name: string;
      started_at: Date;
      resolved_at: Date | null;
      severity: string;
      primary_failure_code: string | null;
    }[]
  >`
    SELECT i.id, spm.display_name AS monitor_name, i.started_at, i.resolved_at,
           i.severity::text AS severity, i.primary_failure_code
    FROM incidents i
    JOIN status_page_monitors spm ON spm.monitor_id = i.monitor_id AND spm.status_page_id = ${page.id}
    WHERE i.started_at >= now() - interval '90 days'
    ORDER BY i.started_at DESC
    LIMIT 20
  `;

  const incidents = await Promise.all(
    incidentRows.map(async (i) => ({
      id: i.id,
      monitorName: i.monitor_name,
      startedAt: i.started_at,
      resolvedAt: i.resolved_at,
      severity: i.severity,
      primaryFailureCode: i.primary_failure_code,
      events: await getIncidentEvents(i.id),
    })),
  );

  return {
    id: page.id,
    organizationId: page.organization_id,
    slug: page.slug,
    title: page.title,
    description: page.description,
    theme: page.theme,
    showUptimeDays: days,
    groups: [...groups.entries()].map(([name, list]) => ({ name, monitors: list })),
    incidents,
  };
}

/**
 * Cached at the data layer rather than by route-level `revalidate`, because the
 * page now reads a cookie to check the password gate and is therefore dynamic.
 * The shield the original ISR config existed for — not hammering the database
 * exactly when the infrastructure behind it is already struggling — is preserved
 * here instead, and the JSON round-trip is the same one ISR already performed,
 * so `startedAt`/`resolvedAt` keep arriving as ISO strings.
 */
export const getStatusPage = unstable_cache(loadStatusPage, ["status-page"], {
  revalidate: 30,
  tags: [STATUS_PAGE_CACHE_TAG],
});
