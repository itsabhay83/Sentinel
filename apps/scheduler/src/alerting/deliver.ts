import { sql as rawSql, withDbRetry } from "@sentinel/db";
import { getServerEnv } from "@sentinel/shared/env";

import { logger } from "../logger";
import { alertDeliveries, alertDeliveriesDead } from "../metrics";
import { captureError } from "../sentry";
import { retryAt } from "./backoff";
import { deliver, type PendingDelivery } from "./transports";

/**
 * A `sending` row older than this belonged to a scheduler that died mid-flight.
 * Every transport here times out inside ten seconds, so nothing legitimate is
 * still in progress after five minutes — and leaving the row untouched would be
 * the silent drop this whole path exists to prevent.
 */
const STUCK_CLAIM = "5 minutes";

/**
 * Claims deliveries that are new, due for retry, or stranded by a dead peer.
 *
 * A failed page must never be terminal on its own: a row moves to `failed` with
 * a future `next_attempt_at` and is re-claimed here, and only reaches `dead`
 * once the attempt budget is spent. `FOR UPDATE SKIP LOCKED` plus the flip to
 * `sending` is what stops a live peer re-claiming the same row.
 */
async function claimDue(limit: number): Promise<PendingDelivery[]> {
  return withDbRetry(
    () => rawSql<PendingDelivery[]>`
      UPDATE alert_deliveries d SET status = 'sending', attempted_at = now()
      WHERE d.id IN (
        SELECT id FROM alert_deliveries
        WHERE status = 'pending'
           OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
           OR (status = 'sending' AND attempted_at <= now() - ${STUCK_CLAIM}::interval)
        ORDER BY coalesce(next_attempt_at, attempted_at)
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.kind, d.step_index, d.incident_id, d.attempts,
        (SELECT ch.kind FROM alert_channels ch WHERE ch.id = d.channel_id) AS channel_kind,
        (SELECT ch.name FROM alert_channels ch WHERE ch.id = d.channel_id) AS channel_name,
        (SELECT ch.config FROM alert_channels ch WHERE ch.id = d.channel_id) AS config,
        (SELECT i.severity FROM incidents i WHERE i.id = d.incident_id) AS severity,
        (SELECT i.started_at FROM incidents i WHERE i.id = d.incident_id) AS started_at,
        (SELECT i.resolved_at FROM incidents i WHERE i.id = d.incident_id) AS resolved_at,
        (SELECT i.primary_failure_code FROM incidents i WHERE i.id = d.incident_id) AS primary_failure_code,
        (SELECT i.affected_regions FROM incidents i WHERE i.id = d.incident_id) AS affected_regions,
        (SELECT m.id FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE i.id = d.incident_id) AS monitor_id,
        (SELECT m.name FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE i.id = d.incident_id) AS monitor_name,
        (SELECT m.url FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE i.id = d.incident_id) AS monitor_url
    `,
    "claim alert deliveries",
  );
}

async function recordFailure(
  row: PendingDelivery,
  error: unknown,
  maxAttempts: number,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const attempts = row.attempts + 1;
  const exhausted = attempts >= maxAttempts;
  const nextAttemptAt = exhausted ? null : retryAt(attempts).toISOString();

  await rawSql`
    UPDATE alert_deliveries
    SET status = ${exhausted ? "dead" : "failed"}::alert_delivery_status,
        error = ${message},
        attempts = ${attempts},
        next_attempt_at = ${nextAttemptAt}::timestamptz
    WHERE id = ${row.id}
  `;

  const context = {
    deliveryId: row.id,
    incidentId: row.incident_id,
    channel: row.channel_name,
    channelKind: row.channel_kind,
    kind: row.kind,
    monitor: row.monitor_name,
    attempts,
  };

  if (exhausted) {
    alertDeliveries.inc({ status: "dead" });
    alertDeliveriesDead.inc();
    captureError(error, context);
    logger.error(
      { ...context, err: message },
      "alert delivery is dead: retry budget spent, this notification will never be sent",
    );
    return;
  }

  alertDeliveries.inc({ status: "failed" });
  logger.warn({ ...context, err: message, nextAttemptAt }, "alert delivery failed; retry scheduled");
}

export async function deliverPendingAlerts(limit = 50): Promise<number> {
  const maxAttempts = getServerEnv().ALERT_MAX_DELIVERY_ATTEMPTS;
  const rows = await claimDue(limit);

  let sent = 0;
  for (const row of rows) {
    try {
      const code = await deliver(row);
      await rawSql`
        UPDATE alert_deliveries
        SET status = 'sent', response_code = ${code}, error = NULL,
            attempts = ${row.attempts + 1}, next_attempt_at = NULL
        WHERE id = ${row.id}
      `;
      sent += 1;
      alertDeliveries.inc({ status: "sent" });
      logger.info(
        {
          deliveryId: row.id,
          channel: row.channel_name,
          kind: row.kind,
          monitor: row.monitor_name,
          incidentId: row.incident_id,
          attempts: row.attempts + 1,
        },
        "alert delivered",
      );
    } catch (error) {
      await recordFailure(row, error, maxAttempts);
    }
  }
  return sent;
}
