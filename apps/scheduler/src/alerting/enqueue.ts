import type { Sql } from "../fencing";
import { logger } from "../logger";
import { alertsSuppressed } from "../metrics";

export type AlertKind = "open" | "resolve" | "escalate";

interface ActiveWindow {
  id: string;
  reason: string;
  ends_at: Date | string;
}

/**
 * Enqueues one alert row per channel on the incident's escalation step.
 *
 * Maintenance suppression is a separate read rather than a `NOT EXISTS` on the
 * INSERT so the window that swallowed the page can be named in the log — a
 * silently missing alert is indistinguishable from a broken alerter otherwise.
 * The INSERT keeps `ON CONFLICT DO NOTHING` against the
 * (incident, channel, kind, step) unique index: two schedulers racing to alert
 * on one incident resolve the race in Postgres, not in application logic.
 */
export async function queueIncidentAlert(
  tx: Sql,
  incidentId: string,
  kind: AlertKind,
  stepIndex = 0,
): Promise<void> {
  const [window] = await tx<ActiveWindow[]>`
    SELECT mw.id, mw.reason, mw.ends_at
    FROM incidents i
    JOIN maintenance_windows mw ON i.monitor_id = ANY(mw.monitor_ids)
    WHERE i.id = ${incidentId}
      AND mw.status IN ('scheduled', 'in_progress')
      AND now() BETWEEN mw.starts_at AND mw.ends_at
    LIMIT 1
  `;

  if (window) {
    alertsSuppressed.inc();
    logger.info(
      {
        incidentId,
        kind,
        stepIndex,
        maintenanceWindowId: window.id,
        reason: window.reason,
        endsAt: new Date(window.ends_at).toISOString(),
      },
      "alert suppressed by maintenance window",
    );
    return;
  }

  await tx`
    INSERT INTO alert_deliveries (incident_id, channel_id, kind, step_index, status)
    SELECT ${incidentId}, ch.id, ${kind}, ${stepIndex}, 'pending'
    FROM incidents i
    JOIN monitor_policies mp ON mp.monitor_id = i.monitor_id
    JOIN escalation_steps es ON es.policy_id = mp.policy_id AND es.order_index = ${stepIndex}
    JOIN alert_channels ch ON ch.id = ANY(es.channel_ids)
    WHERE i.id = ${incidentId}
    ON CONFLICT DO NOTHING
  `;
}
