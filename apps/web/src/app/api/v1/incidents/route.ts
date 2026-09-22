import { sql as rawSql } from "@sentinel/db";
import { explainFailure, isFailureCode } from "@sentinel/shared";
import { authenticateApiKey, requireScope, unauthorized } from "@/lib/api-auth";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/ratelimit";
import { toIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** GET /api/v1/incidents?open=true — incident feed for the calling organization. */
export async function GET(request: Request) {
  const caller = await authenticateApiKey(request);
  if (!caller) return unauthorized();

  const rate = await checkRateLimit("apiRead", caller.keyId);
  if (!rate.allowed) return tooManyRequests(rate);

  const denied = requireScope(caller, "incidents:read");
  if (denied) return denied;

  const url = new URL(request.url);
  const openOnly = url.searchParams.get("open") === "true";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const rows = await rawSql<
    {
      id: string;
      monitor_id: string;
      monitor_name: string;
      started_at: Date | string;
      resolved_at: Date | string | null;
      severity: string;
      primary_failure_code: string | null;
      affected_regions: string[] | null;
      acknowledged_at: Date | string | null;
    }[]
  >`
    SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at,
           i.severity::text AS severity, i.primary_failure_code, i.affected_regions, i.acknowledged_at
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE m.organization_id = ${caller.organizationId}
      ${openOnly ? rawSql`AND i.resolved_at IS NULL` : rawSql``}
    ORDER BY i.started_at DESC
    LIMIT ${limit}
  `;

  return Response.json(
    {
      data: rows.map((r) => ({
        id: r.id,
        monitorId: r.monitor_id,
        monitorName: r.monitor_name,
        startedAt: toIso(r.started_at),
        resolvedAt: toIso(r.resolved_at),
        severity: r.severity,
        primaryFailureCode: r.primary_failure_code,
        failureExplanation: r.primary_failure_code && isFailureCode(r.primary_failure_code) ? explainFailure(r.primary_failure_code) : null,
        affectedRegions: r.affected_regions ?? [],
        acknowledgedAt: toIso(r.acknowledged_at),
      })),
    },
    { headers: rateLimitHeaders(rate) },
  );
}
