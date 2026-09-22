import {
  dropExpiredPartitions,
  ensurePartitions,
  findPartitionGaps,
  withDbRetry,
} from "@sentinel/db";
import { limitsFor, type Plan } from "@sentinel/shared";

import type { LeaderFence } from "../fencing";
import { withFence } from "../fencing";
import { logger } from "../logger";
import { partitionBoundsUnparseable, partitionGaps } from "../metrics";

const PLANS = ["free", "pro", "business"] as const;

/**
 * Delete raw checks past the owning organisation's plan retention.
 *
 * Partition drops do the bulk of the work; this catches the tail where a plan
 * retains less than a whole month. Deleting by monitor keeps a free-plan
 * customer's rows from living as long as a business-plan customer's just
 * because they share a partition.
 */
export async function enforceRawRetention(fence: LeaderFence): Promise<number> {
  const deleted = await withDbRetry(
    () =>
      withFence(fence, "enforceRawRetention", async (tx) => {
        const plans = await tx<{ plan: string }[]>`SELECT DISTINCT plan FROM organizations`;
        let removed = 0;
        for (const { plan } of plans) {
          const days = limitsFor(plan as Plan).rawRetentionDays;
          const rows = await tx`
            DELETE FROM checks
            WHERE checked_at < now() - make_interval(days => ${days})
              AND monitor_id IN (
                SELECT m.id FROM monitors m
                JOIN organizations o ON o.id = m.organization_id
                WHERE o.plan = ${plan}
              )
          `;
          removed += rows.count;
        }
        return removed;
      }),
    "enforce raw retention",
  );
  return deleted ?? 0;
}

function coverageWindow(now = new Date()): Date[] {
  return [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))];
}

/**
 * Keep one month of headroom ahead and drop partitions past the longest plan
 * retention.
 *
 * Ensure and drop run as separate fenced transactions: both take an ACCESS
 * EXCLUSIVE lock on the `checks` parent, so combining them would hold every
 * probe's insert off for the duration of both.
 */
export async function maintainPartitions(fence: LeaderFence): Promise<void> {
  await withDbRetry(
    () =>
      withFence(fence, "maintainPartitions.ensure", (tx) =>
        ensurePartitions(tx, { monthsBack: 1, monthsForward: 2 }),
      ),
    "ensure partitions",
  );

  const maxRetention = Math.max(...PLANS.map((plan) => limitsFor(plan).rawRetentionDays));
  const result = await withDbRetry(
    () =>
      withFence(fence, "maintainPartitions.drop", (tx) =>
        dropExpiredPartitions(tx, maxRetention, { logger }),
      ),
    "drop expired partitions",
  );

  if (result !== null) {
    if (result.dropped.length > 0) {
      logger.info({ dropped: result.dropped }, "dropped expired check partitions");
    }
    if (result.unparseable.length > 0) {
      partitionBoundsUnparseable.inc(result.unparseable.length);
      logger.error(
        { partitions: result.unparseable },
        "check partitions have unreadable bounds and can never be aged out",
      );
    }
  }

  // No DEFAULT partition exists by design, so a gap is not a slow leak: every
  // insert that lands in it fails and the whole fleet stops recording checks.
  const gaps = await findPartitionGaps(coverageWindow());
  partitionGaps.set(gaps.length);
  if (gaps.length > 0) {
    logger.error(
      { missing: gaps },
      "checks has no partition covering the required window; inserts will fail",
    );
  }
}
