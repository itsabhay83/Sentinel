import { sql as rawSql } from "@sentinel/db";
import { explainFailure } from "@sentinel/shared";

import { queueIncidentAlert } from "../alerting/index";
import type { LeaderFence, Sql } from "../fencing";
import { withFence } from "../fencing";
import { logger } from "../logger";
import { incidentsOpened } from "../metrics";

/** Alert tiers in days. Each fires exactly once per certificate. */
const CERT_ALERT_DAYS = [30, 14, 7, 1] as const;

interface CertificateRow {
  monitor_id: string;
  monitor_name: string;
  host: string;
  cert_expires_at: Date | null;
  domain_expires_at: Date | null;
  last_alerted_day_bucket: number | null;
}

/**
 * Open an incident when a TLS certificate or domain registration is about to
 * expire.
 *
 * `last_alerted_day_bucket` is what makes this fire once per tier instead of
 * once per sweep: we only alert when the current tier is strictly tighter than
 * the last one recorded.
 */
export async function checkCertificateExpiry(fence: LeaderFence): Promise<number> {
  const rows = await rawSql<CertificateRow[]>`
    SELECT mc.monitor_id, m.name AS monitor_name, mc.host, mc.cert_expires_at,
           mc.domain_expires_at, mc.last_alerted_day_bucket
    FROM monitor_certificates mc
    JOIN monitors m ON m.id = mc.monitor_id
    WHERE m.paused = false
      AND (mc.cert_expires_at IS NOT NULL OR mc.domain_expires_at IS NOT NULL)
  `;

  const now = Date.now();
  let opened = 0;

  for (const row of rows) {
    const candidates = [row.cert_expires_at, row.domain_expires_at].filter(
      (value): value is Date => value instanceof Date,
    );
    if (candidates.length === 0) continue;

    const soonest = candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
    const daysLeft = Math.floor((soonest.getTime() - now) / 86_400_000);
    // The tightest tier crossed, not the widest: CERT_ALERT_DAYS is descending,
    // so `find` would answer 30 for every certificate inside 30 days and the
    // guard below would then suppress the 14, 7 and 1 day alerts forever.
    const tier = CERT_ALERT_DAYS.filter((d) => daysLeft <= d).at(-1);
    if (tier === undefined) continue;

    const previous = row.last_alerted_day_bucket;
    if (previous !== null && previous <= tier) continue;

    const isDomain = row.domain_expires_at?.getTime() === soonest.getTime();
    const subject = isDomain ? "Domain registration" : "TLS certificate";

    const applied = await withFence(fence, "checkCertificateExpiry", async (tx) => {
      const [incident] = await tx<{ id: string }[]>`
        INSERT INTO incidents (monitor_id, started_at, severity, primary_failure_code, affected_regions)
        VALUES (${row.monitor_id}, now(), 'degraded', ${isDomain ? "DOMAIN_EXPIRING" : "CERT_EXPIRING"}, '{}')
        RETURNING id
      `;
      if (!incident) return false;

      await tx`
        INSERT INTO incident_events (incident_id, kind, payload)
        VALUES (${incident.id}, 'opened', ${JSON.stringify({
          reason: `${subject} for ${row.host} expires in ${daysLeft} day(s)`,
          expiresAt: soonest.toISOString(),
          tier,
        })}::jsonb)
      `;
      await tx`
        UPDATE monitor_certificates SET last_alerted_day_bucket = ${tier}
        WHERE monitor_id = ${row.monitor_id}
      `;
      await queueIncidentAlert(tx, incident.id, "open");
      return true;
    });

    if (applied === null) break;
    if (!applied) continue;

    incidentsOpened.inc({ severity: "degraded" });
    logger.warn(
      { monitorId: row.monitor_id, monitor: row.monitor_name, host: row.host, daysLeft, tier },
      "certificate expiry alert",
    );
    opened += 1;
  }

  return opened;
}

interface HeartbeatRow {
  monitor_id: string;
  status: string;
  current_incident_id: string | null;
  is_late: boolean;
}

/**
 * Detect heartbeat monitors that stopped pinging.
 *
 * Heartbeats invert the model: nobody probes them, so the absence of a row is
 * the signal. A monitor is down once `expected_every_seconds + grace_seconds`
 * elapse with no ping, and recovers the moment one arrives.
 */
export async function checkHeartbeats(fence: LeaderFence): Promise<number> {
  const rows = await rawSql<HeartbeatRow[]>`
    SELECT h.monitor_id,
           s.status,
           s.current_incident_id,
           (h.last_ping_at IS NULL AND m.created_at < now() - make_interval(secs => h.expected_every_seconds + h.grace_seconds))
             OR (h.last_ping_at IS NOT NULL AND h.last_ping_at < now() - make_interval(secs => h.expected_every_seconds + h.grace_seconds))
             AS is_late
    FROM heartbeats h
    JOIN monitors m ON m.id = h.monitor_id
    JOIN monitor_state s ON s.monitor_id = h.monitor_id
    WHERE m.paused = false
  `;

  let transitions = 0;

  for (const row of rows) {
    const shouldBeDown = row.is_late;
    if (shouldBeDown === (row.status === "DOWN")) continue;

    const applied = await withFence(fence, "checkHeartbeats", (tx) =>
      shouldBeDown ? openHeartbeatIncident(tx, row) : resolveHeartbeatIncident(tx, row),
    );
    if (applied === null) break;
    transitions += 1;
  }

  return transitions;
}

async function openHeartbeatIncident(tx: Sql, row: HeartbeatRow): Promise<boolean> {
  const [incident] = await tx<{ id: string }[]>`
    INSERT INTO incidents (monitor_id, started_at, severity, primary_failure_code, affected_regions)
    VALUES (${row.monitor_id}, now(), 'down', 'HEARTBEAT_MISSED', '{}')
    RETURNING id
  `;
  if (!incident) return false;

  await tx`
    INSERT INTO incident_events (incident_id, kind, payload)
    VALUES (${incident.id}, 'opened', ${JSON.stringify({
      reason: explainFailure("HEARTBEAT_MISSED").explanation,
    })}::jsonb)
  `;
  await tx`
    UPDATE monitor_state
    SET status = 'DOWN', since = now(), last_check_at = now(),
        consecutive_failures = consecutive_failures + 1,
        consecutive_successes = 0,
        current_incident_id = ${incident.id}
    WHERE monitor_id = ${row.monitor_id}
  `;
  await queueIncidentAlert(tx, incident.id, "open");
  incidentsOpened.inc({ severity: "down" });
  logger.warn({ monitorId: row.monitor_id, incidentId: incident.id }, "heartbeat missed");
  return true;
}

async function resolveHeartbeatIncident(tx: Sql, row: HeartbeatRow): Promise<boolean> {
  if (row.current_incident_id) {
    await tx`
      UPDATE incidents SET resolved_at = now()
      WHERE id = ${row.current_incident_id} AND resolved_at IS NULL
    `;
    await tx`
      INSERT INTO incident_events (incident_id, kind, payload)
      VALUES (${row.current_incident_id}, 'resolved', ${JSON.stringify({ reason: "Heartbeat received" })}::jsonb)
    `;
    await queueIncidentAlert(tx, row.current_incident_id, "resolve");
  }
  await tx`
    UPDATE monitor_state
    SET status = 'UP', since = now(), last_check_at = now(),
        consecutive_failures = 0,
        consecutive_successes = consecutive_successes + 1,
        current_incident_id = NULL
    WHERE monitor_id = ${row.monitor_id}
  `;
  return true;
}
