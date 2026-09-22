import { sql as rawSql } from "@sentinel/db";
import { getServerEnv } from "@sentinel/shared/env";

import type { LeaderFence } from "../fencing";
import { withFence } from "../fencing";
import { logger } from "../logger";
import { alertDeliveries, alertDeliveriesDead } from "../metrics";
import { captureError } from "../sentry";
import { retryAt } from "./backoff";
import { postEmail } from "./transports";

interface SubscriberNotification {
  id: string;
  kind: string;
  attempts: number;
  email: string;
  unsubscribe_token: string;
  page_title: string;
  page_slug: string;
  service_name: string;
  severity: string;
  started_at: Date | string;
  resolved_at: Date | string | null;
}

/**
 * Status page subscribers only ever see the page's own vocabulary: the public
 * display name, never the monitor name or target URL the operator sees.
 */
function summarizeForSubscriber(row: SubscriberNotification): { title: string; body: string } {
  const env = getServerEnv();
  const resolved = row.kind === "resolve";
  const label =
    row.severity === "down"
      ? "Outage"
      : row.severity === "partial"
        ? "Partial outage"
        : "Degraded performance";

  const lines = [
    resolved
      ? `${row.service_name} is working normally again.`
      : `We are investigating an issue affecting ${row.service_name}.`,
    "",
    `Service: ${row.service_name}`,
    `Impact: ${label}`,
    `Started: ${new Date(row.started_at).toUTCString()}`,
  ];
  if (resolved && row.resolved_at) lines.push(`Resolved: ${new Date(row.resolved_at).toUTCString()}`);
  lines.push(
    "",
    `Live status: ${env.NEXT_PUBLIC_APP_URL}/status/${row.page_slug}`,
    `Unsubscribe: ${env.NEXT_PUBLIC_APP_URL}/status/unsubscribe/${row.unsubscribe_token}`,
  );

  return {
    title: resolved
      ? `Resolved: ${row.service_name} — ${row.page_title}`
      : `${label}: ${row.service_name} — ${row.page_title}`,
    body: lines.join("\n"),
  };
}

/**
 * `s.confirmed_at <= i.started_at` is doing two jobs: someone who subscribes
 * during an outage is not told about it retroactively, and a fresh install does
 * not blast its back catalogue at the first person who signs up.
 */
async function fanOut(fence: LeaderFence): Promise<void> {
  await withFence(fence, "notifySubscribers.fanOut", async (tx) => {
    await tx`
      INSERT INTO status_page_notifications (incident_id, subscriber_id, kind)
      SELECT i.id, s.id, k.kind
      FROM incidents i
      JOIN status_page_monitors spm ON spm.monitor_id = i.monitor_id
      JOIN status_pages p ON p.id = spm.status_page_id AND p.published = true
      JOIN status_page_subscribers s ON s.status_page_id = p.id AND s.confirmed_at IS NOT NULL
      CROSS JOIN unnest(ARRAY['open', 'resolve']) AS k(kind)
      WHERE i.started_at > now() - interval '7 days'
        AND s.confirmed_at <= i.started_at
        AND (k.kind = 'open' OR i.resolved_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_windows mw
          WHERE i.monitor_id = ANY(mw.monitor_ids)
            AND mw.status IN ('scheduled', 'in_progress')
            AND i.started_at BETWEEN mw.starts_at AND mw.ends_at
        )
      ON CONFLICT DO NOTHING
    `;
  });
}

/** A `sending` row this old belonged to a scheduler that died mid-flight. */
const STUCK_CLAIM = "5 minutes";

async function claimDue(limit: number): Promise<SubscriberNotification[]> {
  return rawSql<SubscriberNotification[]>`
    UPDATE status_page_notifications n
    SET status = 'sending', attempted_at = now()
    WHERE n.id IN (
      SELECT id FROM status_page_notifications
      WHERE status = 'pending'
         OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
         OR (status = 'sending' AND attempted_at <= now() - ${STUCK_CLAIM}::interval)
      ORDER BY attempted_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      n.id, n.kind, n.attempts,
      (SELECT s.email FROM status_page_subscribers s WHERE s.id = n.subscriber_id) AS email,
      (SELECT s.unsubscribe_token FROM status_page_subscribers s WHERE s.id = n.subscriber_id) AS unsubscribe_token,
      (SELECT p.title FROM status_page_subscribers s
         JOIN status_pages p ON p.id = s.status_page_id
        WHERE s.id = n.subscriber_id) AS page_title,
      (SELECT p.slug FROM status_page_subscribers s
         JOIN status_pages p ON p.id = s.status_page_id
        WHERE s.id = n.subscriber_id) AS page_slug,
      (SELECT spm.display_name FROM status_page_subscribers s
         JOIN status_page_monitors spm ON spm.status_page_id = s.status_page_id
         JOIN incidents i ON i.id = n.incident_id AND i.monitor_id = spm.monitor_id
        WHERE s.id = n.subscriber_id) AS service_name,
      (SELECT i.severity::text FROM incidents i WHERE i.id = n.incident_id) AS severity,
      (SELECT i.started_at FROM incidents i WHERE i.id = n.incident_id) AS started_at,
      (SELECT i.resolved_at FROM incidents i WHERE i.id = n.incident_id) AS resolved_at
  `;
}

async function recordFailure(
  row: SubscriberNotification,
  error: unknown,
  maxAttempts: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = row.attempts + 1;
  const exhausted = attempts >= maxAttempts;
  const nextAttemptAt = exhausted ? null : retryAt(attempts).toISOString();

  await rawSql`
    UPDATE status_page_notifications
    SET status = ${exhausted ? "dead" : "failed"}::alert_delivery_status,
        error = ${message.slice(0, 500)},
        attempts = ${attempts},
        next_attempt_at = ${nextAttemptAt}::timestamptz
    WHERE id = ${row.id}
  `;

  const context = {
    notificationId: row.id,
    page: row.page_slug,
    kind: row.kind,
    attempts,
    maxAttempts,
  };
  if (exhausted) {
    alertDeliveries.inc({ status: "dead" });
    alertDeliveriesDead.inc();
    captureError(error, context);
    logger.error(
      { ...context, err: message },
      "subscriber notification is dead: retry budget spent, this email will never be sent",
    );
    return;
  }

  alertDeliveries.inc({ status: "failed" });
  logger.warn(
    { ...context, err: message, nextAttemptAt },
    "subscriber notification failed; retry scheduled",
  );
}

/**
 * Fans incidents out to confirmed status page subscribers.
 *
 * Enqueue and send are separate passes for the same reason the operator alert
 * path splits them: the ledger row must exist before any mail leaves, so a
 * crash mid-batch resumes instead of re-mailing everyone.
 */
export async function notifyStatusPageSubscribers(
  fence: LeaderFence,
  limit = 100,
): Promise<number> {
  await fanOut(fence);
  const claimed = await claimDue(limit);
  const maxAttempts = getServerEnv().ALERT_MAX_DELIVERY_ATTEMPTS;

  let sent = 0;
  for (const row of claimed) {
    try {
      const { title, body } = summarizeForSubscriber(row);
      await postEmail(row.email, title, body);
      await rawSql`
        UPDATE status_page_notifications
        SET status = 'sent', error = NULL, next_attempt_at = NULL
        WHERE id = ${row.id}
      `;
      sent += 1;
      alertDeliveries.inc({ status: "sent" });
    } catch (error) {
      await recordFailure(row, error, maxAttempts);
    }
  }
  return sent;
}
