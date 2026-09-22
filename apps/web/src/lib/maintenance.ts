/**
 * Maintenance window lifecycle and the public projection of it.
 *
 * `maintenance_windows.status` is already load-bearing on the write side: the
 * scheduler suppresses alerts only while a window is `scheduled` or
 * `in_progress` (see `queueIncidentAlert` and the subscriber fan-out). Moving a
 * window to `completed` or `cancelled` therefore restores paging immediately,
 * which is why the transitions below are a small closed set rather than a free
 * text update.
 *
 * `published_at` is the separate decision of whether customers get told. A
 * window suppresses alerts whether or not it is published.
 */
import "server-only";

import { unstable_cache } from "next/cache";
import { sql as rawSql } from "@sentinel/db";

import { STATUS_PAGE_CACHE_TAG } from "@/lib/queries";

export const MAINTENANCE_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;

export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Statuses a window may move to, and the statuses it may legally move from. */
export const MAINTENANCE_TRANSITIONS = {
  in_progress: ["scheduled"],
  completed: ["in_progress"],
  cancelled: ["scheduled", "in_progress"],
} as const satisfies Partial<Record<MaintenanceStatus, readonly MaintenanceStatus[]>>;

export type MaintenanceTransition = keyof typeof MAINTENANCE_TRANSITIONS;

/** True while the scheduler still suppresses alerts for this window. */
export function suppressesAlerts(status: MaintenanceStatus): boolean {
  return status === "scheduled" || status === "in_progress";
}

export type MaintenanceWindowRow = {
  id: string;
  reason: string;
  startsAt: string;
  endsAt: string;
  status: MaintenanceStatus;
  published: boolean;
  /** Whether now() falls inside the window, decided by Postgres rather than by the browser's clock. */
  inWindow: boolean;
  ended: boolean;
  monitors: string[];
};

export async function listMaintenanceWindows(organizationId: string): Promise<MaintenanceWindowRow[]> {
  const rows = await rawSql<
    {
      id: string;
      reason: string;
      starts_at: string;
      ends_at: string;
      status: MaintenanceStatus;
      published: boolean;
      in_window: boolean;
      ended: boolean;
      monitors: string[] | null;
    }[]
  >`
    SELECT w.id, w.reason, w.status,
           to_char(w.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
           to_char(w.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
           (w.published_at IS NOT NULL) AS published,
           (now() BETWEEN w.starts_at AND w.ends_at) AS in_window,
           (w.ends_at <= now()) AS ended,
           (SELECT array_agg(m.name ORDER BY m.name) FROM monitors m WHERE m.id = ANY(w.monitor_ids)) AS monitors
    FROM maintenance_windows w
    WHERE w.organization_id = ${organizationId} AND w.ends_at > now() - interval '7 days'
    ORDER BY w.starts_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    published: r.published,
    inWindow: r.in_window,
    ended: r.ended,
    monitors: r.monitors ?? [],
  }));
}

export type PublicMaintenance = {
  id: string;
  reason: string;
  status: MaintenanceStatus;
  startsAt: string;
  endsAt: string;
  /** Status-page display names only — the internal monitor name never leaves the tenant. */
  services: string[];
};

async function loadPublishedMaintenance(slug: string): Promise<PublicMaintenance[]> {
  const rows = await rawSql<
    {
      id: string;
      reason: string;
      status: MaintenanceStatus;
      starts_at: string;
      ends_at: string;
      services: string[] | null;
    }[]
  >`
    SELECT w.id, w.reason, w.status,
           to_char(w.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
           to_char(w.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
           s.services
    FROM status_pages p
    JOIN maintenance_windows w ON w.organization_id = p.organization_id
    JOIN LATERAL (
      SELECT array_agg(DISTINCT spm.display_name) AS services
      FROM status_page_monitors spm
      WHERE spm.status_page_id = p.id AND spm.monitor_id = ANY(w.monitor_ids)
    ) s ON s.services IS NOT NULL
    WHERE p.slug = ${slug} AND p.published = true
      AND w.published_at IS NOT NULL
      AND w.status IN ('scheduled', 'in_progress')
      AND w.ends_at > now()
    ORDER BY w.starts_at
    LIMIT 20
  `;
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    services: r.services ?? [],
  }));
}

/**
 * Shares `STATUS_PAGE_CACHE_TAG` with `getStatusPage` so one publish invalidates
 * the page and this list together, rather than leaving them 30s out of step.
 */
export const getPublishedMaintenance = unstable_cache(
  loadPublishedMaintenance,
  ["status-page-maintenance"],
  { revalidate: 30, tags: [STATUS_PAGE_CACHE_TAG] },
);
