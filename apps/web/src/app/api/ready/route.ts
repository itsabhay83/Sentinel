import { checkDependencies } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/ready — readiness. 503 while Postgres or Redis are unreachable so
 * the load balancer stops routing traffic instead of serving errors.
 */
export async function GET() {
  const health = await checkDependencies();
  return Response.json(
    { status: health.ok ? "ok" : "degraded", service: "web", ...health },
    { status: health.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
