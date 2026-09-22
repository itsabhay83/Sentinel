/**
 * Organization data export.
 *
 * Every SELECT list below is explicit, and that is the security control: a
 * `SELECT *` here would ship `api_keys.hashed_key`, `status_pages.password_hash`,
 * and the AES-256-GCM blobs in `monitors.headers_encrypted` /
 * `alert_channels.config` — the columns that exist precisely because they carry
 * customer credentials. The export answers "what did you configure", not "what
 * are your secrets", so encrypted fields are reduced to a boolean presence flag.
 *
 * Raw check rows are out of scope: they are machine telemetry, not personal
 * data, and a 90-day window of them would be gigabytes of JSON.
 */
import "server-only";

import { sql as rawSql } from "@sentinel/db";

/**
 * Rows are passed straight to `JSON.stringify` and never read field by field,
 * so the SELECT list is the schema. Naming each column again in TypeScript
 * would duplicate it without making anything safer.
 */
type ExportRows = Record<string, unknown>[];

type OrganizationRow = { id: string; name: string; slug: string; plan: string; created_at: Date };

const INCIDENT_HISTORY = "90 days";
const AUDIT_HISTORY = "90 days";
const AUDIT_ROW_CAP = 5_000;

export async function buildOrganizationExport(organizationId: string) {
  const [organization] = await rawSql<OrganizationRow[]>`
    SELECT id, name, slug, plan, created_at FROM organizations WHERE id = ${organizationId}
  `;
  if (!organization) return null;

  const [members, invitations, monitors, channels, policies, windows, pages, incidents, apiKeys, auditLog] =
    await Promise.all([
      rawSql<ExportRows>`
        SELECT u.name, u.email, m.role, m.created_at AS joined_at
        FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId} ORDER BY m.created_at
      `,
      rawSql<ExportRows>`
        SELECT email, role, status, expires_at
        FROM invitations WHERE organization_id = ${organizationId} ORDER BY expires_at DESC
      `,
      rawSql<ExportRows>`
        SELECT m.id, m.name, m.type::text AS type, m.url, m.method, m.interval_seconds, m.timeout_ms,
               m.follow_redirects, m.max_redirects, m.expected_status_codes, m.quorum_ratio,
               m.min_regions_required, m.degraded_threshold_ms, m.tags, m.group_name, m.paused, m.created_at,
               (m.headers_encrypted IS NOT NULL) AS has_custom_headers,
               (m.body_encrypted IS NOT NULL) AS has_request_body,
               (SELECT coalesce(array_agg(r.region_code ORDER BY r.region_code), '{}')
                  FROM monitor_regions r WHERE r.monitor_id = m.id AND r.enabled) AS regions,
               (SELECT count(*)::int FROM assertions a WHERE a.monitor_id = m.id) AS assertion_count,
               (SELECT json_build_object('targetPercent', s.target_percent, 'windowDays', s.window_days)
                  FROM slos s WHERE s.monitor_id = m.id) AS slo
        FROM monitors m WHERE m.organization_id = ${organizationId} ORDER BY m.name
      `,
      rawSql<ExportRows>`
        SELECT name, kind::text AS kind, verified_at, created_at
        FROM alert_channels WHERE organization_id = ${organizationId} ORDER BY created_at
      `,
      rawSql<ExportRows>`
        SELECT p.name, p.created_at,
          (SELECT json_agg(json_build_object(
             'orderIndex', s.order_index, 'afterMinutes', s.after_minutes,
             'channels', (SELECT coalesce(array_agg(c.name), '{}')
                            FROM alert_channels c WHERE c.id = ANY(s.channel_ids))
           ) ORDER BY s.order_index) FROM escalation_steps s WHERE s.policy_id = p.id) AS steps
        FROM escalation_policies p WHERE p.organization_id = ${organizationId} ORDER BY p.created_at
      `,
      rawSql<ExportRows>`
        SELECT w.reason, w.starts_at, w.ends_at, w.status, w.published_at, w.created_at,
          (SELECT coalesce(array_agg(m.name ORDER BY m.name), '{}')
             FROM monitors m WHERE m.id = ANY(w.monitor_ids)) AS monitors
        FROM maintenance_windows w WHERE w.organization_id = ${organizationId} ORDER BY w.starts_at DESC
      `,
      rawSql<ExportRows>`
        SELECT p.slug, p.title, p.description, p.show_uptime_days, p.published, p.custom_domain, p.created_at,
               (p.password_hash IS NOT NULL) AS password_protected,
          (SELECT count(*)::int FROM status_page_subscribers s
             WHERE s.status_page_id = p.id AND s.confirmed_at IS NOT NULL) AS confirmed_subscribers
        FROM status_pages p WHERE p.organization_id = ${organizationId} ORDER BY p.created_at
      `,
      rawSql<ExportRows>`
        SELECT m.name AS monitor, i.started_at, i.resolved_at, i.severity::text AS severity,
               i.primary_failure_code, i.affected_regions, i.acknowledged_at, i.postmortem
        FROM incidents i JOIN monitors m ON m.id = i.monitor_id
        WHERE m.organization_id = ${organizationId}
          AND i.started_at >= now() - ${INCIDENT_HISTORY}::interval
        ORDER BY i.started_at DESC
      `,
      rawSql<ExportRows>`
        SELECT name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
        FROM api_keys WHERE organization_id = ${organizationId} ORDER BY created_at
      `,
      rawSql<ExportRows>`
        SELECT action, actor_email, actor_type, target_type, target_id, ip, created_at
        FROM audit_logs
        WHERE organization_id = ${organizationId} AND created_at >= now() - ${AUDIT_HISTORY}::interval
        ORDER BY created_at DESC LIMIT ${AUDIT_ROW_CAP}
      `,
    ]);

  return {
    exportedAt: new Date().toISOString(),
    scope: {
      incidentHistory: INCIDENT_HISTORY,
      auditHistory: AUDIT_HISTORY,
      auditRowCap: AUDIT_ROW_CAP,
      excluded: "encrypted credentials, password hashes, API key hashes, session tokens, raw check results",
    },
    organization,
    members,
    invitations,
    monitors,
    alertChannels: channels,
    escalationPolicies: policies,
    maintenanceWindows: windows,
    statusPages: pages,
    incidents,
    apiKeys,
    auditLog,
  };
}

export type OrganizationExport = NonNullable<Awaited<ReturnType<typeof buildOrganizationExport>>>;
