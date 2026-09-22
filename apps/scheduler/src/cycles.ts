import { sql as rawSql } from "@sentinel/db";
import type { MonitorStatus, RegionResult } from "@sentinel/shared";

export interface CycleRow {
  monitor_id: string;
  cycle_id: string;
  quorum_ratio: string;
  min_regions_required: number;
  confirmation_failures: number;
  confirmation_successes: number;
  degraded_threshold_ms: number | null;
  status: MonitorStatus;
  consecutive_failures: number;
  consecutive_successes: number;
  current_incident_id: string | null;
  expected_regions: number;
  results: RegionResult[];
  oldest_check: Date;
}

export const pendingCycles = (): Promise<CycleRow[]> => rawSql<CycleRow[]>`
  SELECT
    m.id AS monitor_id,
    s.current_cycle_id AS cycle_id,
    m.quorum_ratio, m.min_regions_required,
    m.confirmation_failures, m.confirmation_successes,
    m.degraded_threshold_ms,
    s.status, s.consecutive_failures, s.consecutive_successes,
    s.current_incident_id,
    (
      SELECT count(*)::int FROM monitor_regions mr
      JOIN regions r ON r.code = mr.region_code
      WHERE mr.monitor_id = m.id AND mr.enabled AND r.enabled
        AND (r.quarantined_until IS NULL OR r.quarantined_until < now())
    ) AS expected_regions,
    c.results,
    c.oldest_check
  FROM monitors m
  JOIN monitor_state s ON s.monitor_id = m.id
  JOIN LATERAL (
    SELECT
      json_agg(json_build_object(
        'regionCode', ch.region_code,
        'ok', ch.ok,
        'failureCode', ch.failure_code,
        'totalMs', ch.total_ms
      )) AS results,
      min(ch.checked_at) AS oldest_check
    FROM checks ch
    WHERE ch.monitor_id = m.id
      AND ch.cycle_id = s.current_cycle_id
      AND ch.checked_at > now() - interval '1 hour'
  ) c ON true
  WHERE m.paused = false
    AND s.current_cycle_id IS NOT NULL
    AND c.results IS NOT NULL
`;
