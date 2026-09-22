import { sql as rawSql } from "@sentinel/db";
import { checkRateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * Inbound heartbeat endpoint.
 *
 * Cron jobs and batch workers ping this instead of being polled. The scheduler's
 * `checkHeartbeats()` opens a HEARTBEAT_MISSED incident when `last_ping_at`
 * falls further behind than `expected_every_seconds + grace_seconds`.
 *
 * GET and POST are both accepted because the callers are `curl` lines at the end
 * of shell scripts, and half of them will use whichever verb is shorter.
 */
export const dynamic = "force-dynamic";

async function ping(token: string): Promise<Response> {
  // Keyed on the token rather than the IP: one cron box may legitimately ping
  // for dozens of monitors, and a flood against one token must not starve them.
  const limit = await checkRateLimit("heartbeat", token);
  if (!limit.allowed) return tooManyRequests(limit);

  const rows = await rawSql<{ monitor_id: string }[]>`
    UPDATE heartbeats SET last_ping_at = now() WHERE ping_token = ${token} RETURNING monitor_id
  `;
  const row = rows[0];
  if (!row) {
    return Response.json({ ok: false, error: "unknown heartbeat token" }, { status: 404 });
  }

  // A ping is a successful check: clear the failure state so the monitor turns
  // green immediately rather than waiting for the next housekeeping pass.
  await rawSql.begin(async (tx) => {
    await tx`
      UPDATE monitor_state
      SET status = 'UP', last_check_at = now(), consecutive_failures = 0,
          consecutive_successes = consecutive_successes + 1,
          since = CASE WHEN status <> 'UP' THEN now() ELSE since END
      WHERE monitor_id = ${row.monitor_id}
    `;
    const open = await tx<{ id: string }[]>`
      UPDATE incidents SET resolved_at = now()
      WHERE monitor_id = ${row.monitor_id} AND resolved_at IS NULL AND primary_failure_code = 'HEARTBEAT_MISSED'
      RETURNING id
    `;
    for (const incident of open) {
      await tx`INSERT INTO incident_events (incident_id, kind, payload) VALUES (${incident.id}, 'resolved', ${JSON.stringify({ via: "heartbeat ping" })}::jsonb)`;
      await tx`UPDATE monitor_state SET current_incident_id = NULL WHERE monitor_id = ${row.monitor_id}`;
    }
  });

  return Response.json({ ok: true, monitorId: row.monitor_id, receivedAt: new Date().toISOString() });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return ping(token);
}

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return ping(token);
}
