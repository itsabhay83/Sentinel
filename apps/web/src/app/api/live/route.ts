export const dynamic = "force-dynamic";

/**
 * GET /api/live — liveness only. Deliberately touches no dependency: a failing
 * database must not cause the orchestrator to restart a process that is fine.
 */
export function GET() {
  return Response.json(
    { status: "ok", service: "web", uptimeSeconds: Math.round(process.uptime()) },
    { headers: { "cache-control": "no-store" } },
  );
}
