import { sql as rawSql } from "@sentinel/db";
import { authenticateApiKey, requireScope, unauthorized } from "@/lib/api-auth";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/ratelimit";
import { toIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/monitors — list monitors with their current state.
 *
 * Deliberately read-only for now. Writes through the API would need idempotency
 * keys and per-key rate limits to be safe, and shipping a half-guarded write
 * endpoint is worse than shipping none.
 *
 * The budget is spent before the scope check so that hammering an endpoint the
 * key is not entitled to costs the caller the same as hammering one it is.
 */
export async function GET(request: Request) {
  const caller = await authenticateApiKey(request);
  if (!caller) return unauthorized();

  const limit = await checkRateLimit("apiRead", caller.keyId);
  if (!limit.allowed) return tooManyRequests(limit);

  const denied = requireScope(caller, "monitors:read");
  if (denied) return denied;

  const rows = await rawSql<
    {
      id: string;
      name: string;
      url: string;
      type: string;
      status: string | null;
      paused: boolean;
      interval_seconds: number;
      last_check_at: Date | string | null;
      last_latency_ms: number | null;
      failing_regions: string[] | null;
      uptime_30d: string | null;
      regions: string[] | null;
    }[]
  >`
    SELECT m.id, m.name, m.url, m.type::text, s.status::text AS status, m.paused, m.interval_seconds,
           s.last_check_at, s.last_latency_ms, s.failing_regions,
           (SELECT sum(ok_count)::numeric / NULLIF(sum(count), 0) FROM check_rollups_1h
             WHERE monitor_id = m.id AND bucket >= now() - interval '30 days') AS uptime_30d,
           (SELECT array_agg(region_code ORDER BY region_code) FROM monitor_regions WHERE monitor_id = m.id AND enabled) AS regions
    FROM monitors m
    LEFT JOIN monitor_state s ON s.monitor_id = m.id
    WHERE m.organization_id = ${caller.organizationId}
    ORDER BY m.name
  `;

  return Response.json(
    {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        type: r.type,
        status: r.paused ? "PAUSED" : (r.status ?? "PENDING"),
        intervalSeconds: r.interval_seconds,
        regions: r.regions ?? [],
        failingRegions: r.failing_regions ?? [],
        lastCheckAt: toIso(r.last_check_at),
        lastLatencyMs: r.last_latency_ms,
        uptime30d: r.uptime_30d == null ? null : Number(r.uptime_30d) * 100,
      })),
    },
    { headers: rateLimitHeaders(limit) },
  );
}
