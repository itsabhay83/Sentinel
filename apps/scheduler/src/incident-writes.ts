import type {
  ConsensusOutcome,
  FailureCode,
  IncidentSeverity,
  MonitorStatus,
} from "@sentinel/shared";

import { queueIncidentAlert } from "./alerting/index";
import type { CycleRow } from "./cycles";
import type { Sql } from "./fencing";
import { logger } from "./logger";
import { incidentsOpened } from "./metrics";

export interface IncidentTransition {
  readonly row: CycleRow;
  readonly status: MonitorStatus;
  readonly consensus: ConsensusOutcome;
  readonly at: Date;
}

interface UnhealthyTransition extends IncidentTransition {
  readonly severity: IncidentSeverity;
}

function severityFor(status: MonitorStatus): IncidentSeverity | null {
  switch (status) {
    case "DOWN":
      return "down";
    case "PARTIAL_OUTAGE":
      return "partial";
    case "DEGRADED":
      return "degraded";
    default:
      return null;
  }
}

async function open(tx: Sql, transition: UnhealthyTransition): Promise<void> {
  const { row, status, consensus, severity, at } = transition;
  const [incident] = await tx<{ id: string }[]>`
    INSERT INTO incidents
      (monitor_id, started_at, severity, primary_failure_code, affected_regions)
    VALUES (
      ${row.monitor_id}, ${at.toISOString()}::timestamptz, ${severity},
      ${consensus.primaryFailureCode satisfies FailureCode | null},
      ${consensus.failingRegions}
    )
    RETURNING id
  `;
  if (!incident) return;

  await tx`
    INSERT INTO incident_events (incident_id, at, kind, payload)
    VALUES (${incident.id}, ${at.toISOString()}::timestamptz, 'opened', ${JSON.stringify({
      cycleId: row.cycle_id,
      status,
      failingRegions: consensus.failingRegions,
      reportingRegions: consensus.reportingRegions,
      quorumThreshold: consensus.quorumThreshold,
      primaryFailureCode: consensus.primaryFailureCode,
    })}::jsonb)
  `;
  await tx`
    UPDATE monitor_state SET current_incident_id = ${incident.id}
    WHERE monitor_id = ${row.monitor_id}
  `;
  await queueIncidentAlert(tx, incident.id, "open");
  incidentsOpened.inc({ severity });
  logger.warn(
    {
      cycleId: row.cycle_id,
      monitorId: row.monitor_id,
      status,
      incidentId: incident.id,
      failing: consensus.failingRegions,
    },
    "incident opened",
  );
}

async function changeSeverity(
  tx: Sql,
  transition: UnhealthyTransition,
  incidentId: string,
): Promise<void> {
  const { row, status, consensus, severity, at } = transition;
  await tx`
    UPDATE incidents SET severity = ${severity}, affected_regions = ${consensus.failingRegions}
    WHERE id = ${incidentId}
  `;
  await tx`
    INSERT INTO incident_events (incident_id, at, kind, payload)
    VALUES (${incidentId}, ${at.toISOString()}::timestamptz, 'severity_changed', ${JSON.stringify({
      cycleId: row.cycle_id,
      status,
      failingRegions: consensus.failingRegions,
    })}::jsonb)
  `;
}

async function resolve(tx: Sql, transition: IncidentTransition, incidentId: string): Promise<void> {
  const { row, status, at } = transition;
  await tx`
    UPDATE incidents SET resolved_at = ${at.toISOString()}::timestamptz
    WHERE id = ${incidentId} AND resolved_at IS NULL
  `;
  await tx`
    INSERT INTO incident_events (incident_id, at, kind, payload)
    VALUES (${incidentId}, ${at.toISOString()}::timestamptz, 'resolved', ${JSON.stringify({
      cycleId: row.cycle_id,
      status,
    })}::jsonb)
  `;
  await tx`
    UPDATE monitor_state SET current_incident_id = NULL WHERE monitor_id = ${row.monitor_id}
  `;
  await queueIncidentAlert(tx, incidentId, "resolve");
  logger.info({ cycleId: row.cycle_id, monitorId: row.monitor_id, incidentId }, "incident resolved");
}

/** Reconciles the incident ledger with a status the evaluator has already decided. */
export async function applyIncidentTransition(
  tx: Sql,
  transition: IncidentTransition,
): Promise<void> {
  const severity = severityFor(transition.status);
  const incidentId = transition.row.current_incident_id;

  if (severity !== null) {
    const unhealthy: UnhealthyTransition = { ...transition, severity };
    await (incidentId === null ? open(tx, unhealthy) : changeSeverity(tx, unhealthy, incidentId));
    return;
  }

  if (incidentId !== null) {
    await resolve(tx, transition, incidentId);
  }
}
