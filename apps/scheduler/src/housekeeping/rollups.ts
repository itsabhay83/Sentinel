import { withDbRetry } from "@sentinel/db";

import type { LeaderFence } from "../fencing";
import { withFence } from "../fencing";

/**
 * Leader-only aggregate maintenance.
 *
 * Every statement here is an idempotent upsert, but two schedulers recomputing
 * the same trailing window would still race each other's partial reads, so each
 * runs under the fencing token its instance was elected with.
 */

/**
 * Roll raw checks into 5-minute buckets.
 *
 * Recomputes the trailing window rather than only the newest bucket: probes can
 * land late, and a bucket that was summarised while half its checks were still
 * in flight must be corrected. ON CONFLICT DO UPDATE makes the recompute free.
 */
export async function rollup5m(fence: LeaderFence, lookbackMinutes = 30): Promise<number> {
  const written = await withDbRetry(
    () =>
      withFence(fence, "rollup5m", async (tx) => {
        const rows = await tx`
          INSERT INTO check_rollups_5m (monitor_id, region_code, bucket, count, ok_count, p50_ms, p95_ms, p99_ms, max_ms)
          SELECT
            monitor_id,
            region_code,
            to_timestamp(floor(extract(epoch FROM checked_at) / 300) * 300) AS bucket,
            count(*)::int,
            count(*) FILTER (WHERE ok)::int,
            coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE ok), 0)::int,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE ok), 0)::int,
            coalesce(percentile_disc(0.99) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE ok), 0)::int,
            coalesce(max(total_ms) FILTER (WHERE ok), 0)::int
          FROM checks
          WHERE checked_at >= now() - make_interval(mins => ${lookbackMinutes})
          GROUP BY 1, 2, 3
          ON CONFLICT (monitor_id, region_code, bucket) DO UPDATE SET
            count = EXCLUDED.count,
            ok_count = EXCLUDED.ok_count,
            p50_ms = EXCLUDED.p50_ms,
            p95_ms = EXCLUDED.p95_ms,
            p99_ms = EXCLUDED.p99_ms,
            max_ms = EXCLUDED.max_ms
          RETURNING 1
        `;
        return rows.length;
      }),
    "rollup 5m",
  );
  return written ?? 0;
}

/**
 * Roll 5-minute buckets into hourly ones.
 *
 * Derived from the 5m table, not from raw checks, so hourly history survives
 * raw-check retention deletion. The percentiles are therefore percentiles of
 * bucket percentiles - an approximation we accept because the alternative is
 * keeping raw rows for 13 months.
 */
export async function rollup1h(fence: LeaderFence, lookbackHours = 3): Promise<number> {
  const written = await withDbRetry(
    () =>
      withFence(fence, "rollup1h", async (tx) => {
        const rows = await tx`
          INSERT INTO check_rollups_1h (monitor_id, region_code, bucket, count, ok_count, p50_ms, p95_ms, p99_ms, max_ms)
          SELECT
            monitor_id,
            region_code,
            date_trunc('hour', bucket) AS hour_bucket,
            sum(count)::int,
            sum(ok_count)::int,
            coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY p50_ms), 0)::int,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY p95_ms), 0)::int,
            coalesce(percentile_disc(0.99) WITHIN GROUP (ORDER BY p99_ms), 0)::int,
            coalesce(max(max_ms), 0)::int
          FROM check_rollups_5m
          WHERE bucket >= date_trunc('hour', now() - make_interval(hours => ${lookbackHours}))
          GROUP BY 1, 2, 3
          ON CONFLICT (monitor_id, region_code, bucket) DO UPDATE SET
            count = EXCLUDED.count,
            ok_count = EXCLUDED.ok_count,
            p50_ms = EXCLUDED.p50_ms,
            p95_ms = EXCLUDED.p95_ms,
            p99_ms = EXCLUDED.p99_ms,
            max_ms = EXCLUDED.max_ms
          RETURNING 1
        `;
        return rows.length;
      }),
    "rollup 1h",
  );
  return written ?? 0;
}

/**
 * Recompute the per-(monitor, region) latency baseline used by degradation
 * detection. Seven days of hourly buckets is long enough to absorb a weekly
 * traffic cycle and short enough that a genuine permanent slowdown eventually
 * becomes the new normal instead of alerting forever.
 */
export async function refreshLatencyBaselines(fence: LeaderFence): Promise<number> {
  const written = await withDbRetry(
    () =>
      withFence(fence, "refreshLatencyBaselines", async (tx) => {
        const rows = await tx`
          INSERT INTO latency_baselines (monitor_id, region_code, p95_ms, sample_count, computed_at)
          SELECT
            monitor_id,
            region_code,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY p95_ms), 0)::int,
            sum(count)::int,
            now()
          FROM check_rollups_1h
          WHERE bucket >= now() - interval '7 days'
          GROUP BY 1, 2
          HAVING sum(count) >= 30
          ON CONFLICT (monitor_id, region_code) DO UPDATE SET
            p95_ms = EXCLUDED.p95_ms,
            sample_count = EXCLUDED.sample_count,
            computed_at = EXCLUDED.computed_at
          RETURNING 1
        `;
        return rows.length;
      }),
    "refresh latency baselines",
  );
  return written ?? 0;
}
