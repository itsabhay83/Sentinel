"use server";

/**
 * SLO targets. The `slos` table shipped with the schema and a reader in
 * `queries.ts`, but nothing ever wrote a row, so the error budget on every
 * monitor page was permanently "no SLO configured".
 *
 * `slos` carries no `organization_id` — `monitor_id` is its only tenant link.
 * Every statement below therefore either joins through `monitors` or is gated
 * by a prior ownership lookup against `monitors.organization_id`.
 */

import { revalidatePath } from "next/cache";
import { sql as rawSql } from "@sentinel/db";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { guardRole, requireRole } from "@/lib/rbac";
import {
  MAX_TARGET_PERCENT,
  MAX_WINDOW_DAYS,
  MIN_TARGET_PERCENT,
  MIN_WINDOW_DAYS,
} from "@/lib/slo";
import type { ActionState } from "@/lib/actions/settings";

const SLOS_PATH = "/slos";

const sloSchema = z.object({
  monitorId: z.string().uuid(),
  targetPercent: z.coerce
    .number()
    .min(MIN_TARGET_PERCENT, `Target must be at least ${MIN_TARGET_PERCENT}%`)
    // A 100% target allows zero failures, which makes the burn rate a division
    // by zero and the budget meaningless. Stop it at the boundary instead.
    .max(MAX_TARGET_PERCENT, `Target must be below ${MAX_TARGET_PERCENT}%`),
  windowDays: z.coerce
    .number()
    .int()
    .min(MIN_WINDOW_DAYS, "The window must cover at least a day")
    .max(MAX_WINDOW_DAYS, `The window cannot exceed ${MAX_WINDOW_DAYS} days`),
});

/**
 * Creates or replaces the monitor's SLO. `slos_monitor_unique` allows exactly
 * one per monitor, so a second "create" is an edit whether or not the user
 * thought of it that way.
 */
export async function saveSloAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("member");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  const parsed = sloSchema.safeParse({
    monitorId: formData.get("monitorId"),
    targetPercent: formData.get("targetPercent"),
    windowDays: formData.get("windowDays"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { monitorId, targetPercent, windowDays } = parsed.data;

  const [monitor] = await rawSql<{ id: string; name: string }[]>`
    SELECT id, name FROM monitors WHERE id = ${monitorId} AND organization_id = ${org.id}
  `;
  if (!monitor) return { error: "Monitor not found" };

  const [existing] = await rawSql<{ monitor_id: string }[]>`
    SELECT monitor_id FROM slos WHERE monitor_id = ${monitorId}
  `;

  // numeric(6,3): sending a float would round at the driver rather than at the
  // column, so the stored target could differ from the one that was validated.
  await rawSql`
    INSERT INTO slos (monitor_id, target_percent, window_days)
    VALUES (${monitorId}, ${targetPercent.toFixed(3)}::numeric, ${windowDays})
    ON CONFLICT (monitor_id)
    DO UPDATE SET target_percent = EXCLUDED.target_percent, window_days = EXCLUDED.window_days
  `;

  await recordAudit({
    action: existing ? "slo.updated" : "slo.created",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "slo",
    targetId: monitorId,
    metadata: { monitor: monitor.name, targetPercent, windowDays },
  });

  revalidatePath(SLOS_PATH);
  revalidatePath(`${SLOS_PATH}/${monitorId}`);
  revalidatePath(`/monitors/${monitorId}`);
  return { ok: true };
}

export async function deleteSloAction(monitorId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("member");
  const [removed] = await rawSql<{ monitor_id: string; name: string }[]>`
    DELETE FROM slos s
    USING monitors m
    WHERE s.monitor_id = ${monitorId} AND m.id = s.monitor_id AND m.organization_id = ${org.id}
    RETURNING s.monitor_id, m.name
  `;
  if (removed) {
    await recordAudit({
      action: "slo.deleted",
      organizationId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "slo",
      targetId: removed.monitor_id,
      metadata: { monitor: removed.name },
    });
  }

  revalidatePath(SLOS_PATH);
  revalidatePath(`${SLOS_PATH}/${monitorId}`);
  revalidatePath(`/monitors/${monitorId}`);
}
