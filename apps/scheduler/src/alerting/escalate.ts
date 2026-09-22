import { sql as rawSql } from "@sentinel/db";

import type { LeaderFence } from "../fencing";
import { withFence } from "../fencing";
import { logger } from "../logger";
import { queueIncidentAlert } from "./enqueue";

interface DueEscalation {
  incident_id: string;
  order_index: number;
}

/**
 * Advances unacknowledged incidents to their next escalation step.
 *
 * Leader-only: the `NOT EXISTS` guard makes the read idempotent, but the
 * incident_events write is not, so the whole step runs under the fencing token
 * this instance was elected with.
 */
export async function escalateOpenIncidents(fence: LeaderFence): Promise<number> {
  const due = await rawSql<DueEscalation[]>`
    SELECT i.id AS incident_id, es.order_index
    FROM incidents i
    JOIN monitor_policies mp ON mp.monitor_id = i.monitor_id
    JOIN escalation_steps es ON es.policy_id = mp.policy_id
    WHERE i.resolved_at IS NULL
      AND i.acknowledged_at IS NULL
      AND es.order_index > 0
      AND i.started_at + make_interval(mins => es.after_minutes) <= now()
      AND NOT EXISTS (
        SELECT 1 FROM alert_deliveries d
        WHERE d.incident_id = i.id AND d.kind = 'escalate' AND d.step_index = es.order_index
      )
  `;

  let escalated = 0;
  for (const row of due) {
    const applied = await withFence(fence, "escalate", async (tx) => {
      await queueIncidentAlert(tx, row.incident_id, "escalate", row.order_index);
      await tx`
        INSERT INTO incident_events (incident_id, kind, payload)
        VALUES (${row.incident_id}, 'escalated', ${JSON.stringify({ step: row.order_index })}::jsonb)
      `;
      return true;
    });
    if (applied === null) break;
    escalated += 1;
    logger.info(
      { incidentId: row.incident_id, step: row.order_index },
      "incident escalated",
    );
  }
  return escalated;
}
