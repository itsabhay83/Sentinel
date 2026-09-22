import { withDbRetry } from "@sentinel/db";
import { detectQuarantinedRegions, type RegionWindowStats } from "@sentinel/shared";

import type { LeaderFence } from "../fencing";
import { withFence } from "../fencing";
import { logger } from "../logger";

interface RegionWindowRow {
  region_code: string;
  total_checks: number;
  failed_checks: number;
}

/**
 * Quarantine regions whose probes are lying.
 *
 * A region that fails everything while its peers pass is a broken probe, not a
 * global outage - counting it in quorum would drag every monitor toward
 * PARTIAL_OUTAGE. Quarantined regions are excluded from dispatch and from the
 * expected-region count until the window expires and they earn their way back.
 */
export async function updateRegionQuarantine(
  fence: LeaderFence,
  windowMinutes = 15,
): Promise<string[]> {
  const quarantined = await withDbRetry(
    () =>
      withFence(fence, "updateRegionQuarantine", async (tx) => {
        const stats = await tx<RegionWindowRow[]>`
          SELECT region_code,
                 count(*)::int AS total_checks,
                 count(*) FILTER (WHERE NOT ok)::int AS failed_checks
          FROM checks
          WHERE checked_at >= now() - make_interval(mins => ${windowMinutes})
          GROUP BY region_code
        `;

        const windows: RegionWindowStats[] = stats.map((row) => ({
          regionCode: row.region_code,
          totalChecks: Number(row.total_checks),
          failedChecks: Number(row.failed_checks),
        }));

        const decisions = detectQuarantinedRegions(windows);
        const codes: string[] = [];

        for (const decision of decisions) {
          codes.push(decision.regionCode);
          await tx`
            UPDATE regions
            SET health_status = 'quarantined',
                quarantined_until = now() + interval '15 minutes',
                quarantine_reason = ${decision.reason}
            WHERE code = ${decision.regionCode}
          `;
          logger.warn(
            { region: decision.regionCode, reason: decision.reason },
            "region quarantined",
          );
        }

        // Release expired quarantines. A region returns to service
        // automatically; if it is still broken the next window re-quarantines
        // it within a minute.
        const released = await tx<{ code: string }[]>`
          UPDATE regions
          SET health_status = 'healthy', quarantined_until = NULL, quarantine_reason = NULL
          WHERE health_status = 'quarantined'
            AND quarantined_until IS NOT NULL
            AND quarantined_until <= now()
            AND code <> ALL(${codes.length > 0 ? codes : [""]})
          RETURNING code
        `;
        for (const row of released) {
          logger.info({ region: row.code }, "region quarantine released");
        }

        // Mark liveness so the UI can show a probe fleet that stopped
        // reporting.
        await tx`
          UPDATE regions r
          SET last_seen_at = c.last_seen
          FROM (
            SELECT region_code, max(checked_at) AS last_seen
            FROM checks
            WHERE checked_at >= now() - interval '1 hour'
            GROUP BY region_code
          ) c
          WHERE c.region_code = r.code
        `;

        return codes;
      }),
    "update region quarantine",
  );
  return quarantined ?? [];
}

/**
 * Flag incidents that keep reopening.
 *
 * Three or more incidents on one monitor within an hour means the target is
 * oscillating, not recovering. Marking the incident lets the UI stop treating
 * each flap as news.
 */
export async function detectFlapping(fence: LeaderFence): Promise<number> {
  const flagged = await withDbRetry(
    () =>
      withFence(fence, "detectFlapping", async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE incidents i
          SET is_flapping = 'true'
          WHERE i.resolved_at IS NULL
            AND i.is_flapping IS DISTINCT FROM 'true'
            AND (
              SELECT count(*) FROM incidents p
              WHERE p.monitor_id = i.monitor_id
                AND p.started_at >= now() - interval '1 hour'
            ) >= 3
          RETURNING i.id
        `;
        return rows.length;
      }),
    "detect flapping",
  );
  if (flagged !== null && flagged > 0) {
    logger.warn({ count: flagged }, "flapping incidents flagged");
  }
  return flagged ?? 0;
}
