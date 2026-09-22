import { sql as rawSql } from "@sentinel/db";
import type { Assertion, CheckJob } from "@sentinel/shared";
import { decryptJson } from "@sentinel/shared/server";

export interface StoredFlowStep {
  name: string;
  url: string;
  method: string;
  headersEncrypted: string | null;
  bodyEncrypted: string | null;
  expectedStatusCodes: number[] | null;
  extract: Record<string, string> | null;
}

export interface ClaimedMonitor {
  monitor_id: string;
  cycle_id: string;
  type: CheckJob["type"];
  url: string;
  method: string;
  headers_encrypted: string | null;
  body_encrypted: string | null;
  timeout_ms: number;
  follow_redirects: boolean;
  max_redirects: number;
  expected_status_codes: number[] | null;
  regions: string[] | null;
  assertions: Assertion[] | null;
  flow_steps: StoredFlowStep[] | null;
}

const CLAIM_BATCH = 200;

/**
 * Flow steps are stored with per-step ciphertext, but the probe receives the
 * whole array inside one envelope. Decrypting here and re-encrypting once means
 * the probe needs a single unwrap, and per-step secrets are still never written
 * to the database or to Redis in the clear.
 */
export function resolveFlowSteps(steps: StoredFlowStep[], key: string) {
  return steps.map((step) => ({
    name: step.name,
    url: step.url,
    method: step.method,
    headers: decryptJson<Record<string, string>>(step.headersEncrypted, key, {}),
    body: decryptJson<{ value: string | null }>(step.bodyEncrypted, key, { value: null }).value,
    expectedStatusCodes: step.expectedStatusCodes ?? [],
    extract: step.extract ?? {},
  }));
}

/**
 * Claim and advance in ONE statement. `FOR UPDATE ... SKIP LOCKED` inside the
 * CTE makes a second scheduler skip rows this one already holds, and because
 * `next_run_at` is pushed forward in the same statement, no monitor can be
 * dispatched twice even if both instances poll on the same millisecond.
 */
export async function claimDueMonitors(now: Date): Promise<ClaimedMonitor[]> {
  return rawSql<ClaimedMonitor[]>`
    WITH due AS (
      SELECT s.monitor_id
      FROM monitor_state s
      JOIN monitors m ON m.id = s.monitor_id
      WHERE s.next_run_at <= ${now.toISOString()}::timestamptz
        AND m.paused = false
        AND m.type <> 'heartbeat'
      ORDER BY s.next_run_at
      LIMIT ${CLAIM_BATCH}
      FOR UPDATE OF s SKIP LOCKED
    ),
    claimed AS (
      UPDATE monitor_state s
      SET next_run_at = ${now.toISOString()}::timestamptz + make_interval(secs => m.interval_seconds),
          current_cycle_id = gen_random_uuid()
      FROM due d
      JOIN monitors m ON m.id = d.monitor_id
      WHERE s.monitor_id = d.monitor_id
      RETURNING
        s.monitor_id,
        s.current_cycle_id AS cycle_id,
        m.type, m.url, m.method,
        m.headers_encrypted, m.body_encrypted,
        m.timeout_ms, m.follow_redirects, m.max_redirects,
        m.expected_status_codes
    )
    SELECT
      c.*,
      (
        SELECT array_agg(mr.region_code ORDER BY mr.region_code)
        FROM monitor_regions mr
        JOIN regions r ON r.code = mr.region_code
        WHERE mr.monitor_id = c.monitor_id
          AND mr.enabled = true
          AND r.enabled = true
          AND (r.quarantined_until IS NULL OR r.quarantined_until < ${now.toISOString()}::timestamptz)
      ) AS regions,
      (
        SELECT json_agg(json_build_object(
          'id', a.id, 'orderIndex', a.order_index,
          'kind', a.kind, 'target', a.target,
          'operator', a.operator, 'value', a.value
        ) ORDER BY a.order_index)
        FROM assertions a WHERE a.monitor_id = c.monitor_id
      ) AS assertions,
      (
        SELECT json_agg(json_build_object(
          'name', f.name, 'url', f.url, 'method', f.method,
          'headersEncrypted', f.headers_encrypted,
          'bodyEncrypted', f.body_encrypted,
          'expectedStatusCodes', f.expected_status_codes,
          'extract', f.extract
        ) ORDER BY f.order_index)
        FROM flow_steps f WHERE f.monitor_id = c.monitor_id
      ) AS flow_steps
    FROM claimed c
  `;
}
