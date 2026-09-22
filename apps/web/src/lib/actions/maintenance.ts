"use server";

/**
 * The half of the maintenance-window lifecycle that migration 0002 added
 * columns for and nothing ever wrote: `status` and `published_at`.
 *
 * Creating and deleting a window lives in `alerting.ts`, next to escalation
 * policies, because that is the form the alerting page owns. These are the
 * state changes, and they have a different blast radius: a status change stops
 * alert suppression, and publishing exposes the window to anonymous visitors.
 */

import { revalidatePath, revalidateTag } from "next/cache";
import { sql as rawSql } from "@sentinel/db";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { MAINTENANCE_TRANSITIONS, type MaintenanceTransition } from "@/lib/maintenance";
import { STATUS_PAGE_CACHE_TAG } from "@/lib/queries";
import { requireRole } from "@/lib/rbac";

const ALERTS_PATH = "/settings/alerts";

/** Annotated so a new entry in MAINTENANCE_TRANSITIONS that is not accepted here fails the build. */
const transitionSchema: z.ZodType<MaintenanceTransition> = z.enum([
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * The legal source statuses are enforced in the UPDATE's own predicate, so two
 * admins racing to advance the same window cannot both succeed — the second
 * matches no row.
 */
export async function setMaintenanceStatusAction(id: string, next: MaintenanceTransition): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const parsed = transitionSchema.safeParse(next);
  if (!parsed.success) return;
  const allowedFrom: readonly string[] = MAINTENANCE_TRANSITIONS[parsed.data];

  const [row] = await rawSql<{ id: string; reason: string }[]>`
    UPDATE maintenance_windows
    SET status = ${parsed.data}
    WHERE id = ${id}
      AND organization_id = ${org.id}
      AND status = ANY(${[...allowedFrom]}::text[])
    RETURNING id, reason
  `;
  if (!row) return;

  await recordAudit({
    action: parsed.data === "cancelled" ? "maintenance_window.cancelled" : "maintenance_window.updated",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "maintenance_window",
    targetId: row.id,
    metadata: { reason: row.reason, from: allowedFrom, to: parsed.data },
  });

  revalidatePath(ALERTS_PATH);
  revalidateTag(STATUS_PAGE_CACHE_TAG);
}

/**
 * Publishing is independent of suppression: an unpublished window still silences
 * pages, it just does not tell customers. Re-publishing keeps the original
 * timestamp so the announcement date does not move.
 */
export async function setMaintenancePublishedAction(id: string, publish: boolean): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const [row] = await rawSql<{ id: string; reason: string; published: boolean }[]>`
    UPDATE maintenance_windows
    SET published_at = CASE WHEN ${publish}::boolean THEN coalesce(published_at, now()) ELSE NULL END
    WHERE id = ${id} AND organization_id = ${org.id}
    RETURNING id, reason, (published_at IS NOT NULL) AS published
  `;
  if (!row) return;

  await recordAudit({
    action: row.published ? "maintenance_window.published" : "maintenance_window.unpublished",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "maintenance_window",
    targetId: row.id,
    metadata: { reason: row.reason },
  });

  revalidatePath(ALERTS_PATH);
  revalidateTag(STATUS_PAGE_CACHE_TAG);
}
