"use server";

/**
 * Incident actions: acknowledge and postmortem.
 *
 * Acknowledging is not cosmetic — `escalateOpenIncidents()` in the scheduler
 * skips acknowledged incidents, so this is the button that stops the pager.
 */
import { revalidatePath } from "next/cache";
import { sql as rawSql } from "@sentinel/db";
import { z } from "zod";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { guardRole, requireRole } from "@/lib/rbac";

export type ActionState = { error?: string; ok?: boolean } | undefined;

export async function acknowledgeIncidentAction(incidentId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("member");
  await rawSql.begin(async (tx) => {
    const rows = await tx`
      UPDATE incidents i
      SET acknowledged_by = ${user.id}, acknowledged_at = now()
      FROM monitors m
      WHERE i.monitor_id = m.id
        AND i.id = ${incidentId}
        AND m.organization_id = ${org.id}
        AND i.acknowledged_at IS NULL
      RETURNING i.id
    `;
    if (rows.length > 0) {
      await tx`
        INSERT INTO incident_events (incident_id, kind, payload)
        VALUES (${incidentId}, 'acked', ${JSON.stringify({ by: user.name || user.email })}::jsonb)
      `;
    }
  });
  revalidatePath(`/incidents/${incidentId}`);
  revalidatePath("/incidents");
}

const postmortemSchema = z.object({ postmortem: z.string().max(20_000) });

export async function savePostmortemAction(incidentId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("member");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = postmortemSchema.safeParse({ postmortem: formData.get("postmortem") });
  if (!parsed.success) return { error: "Postmortem is too long" };

  await rawSql.begin(async (tx) => {
    await tx`
      UPDATE incidents i SET postmortem = ${parsed.data.postmortem || null}
      FROM monitors m
      WHERE i.monitor_id = m.id AND i.id = ${incidentId} AND m.organization_id = ${org.id}
    `;
    await tx`
      INSERT INTO incident_events (incident_id, kind, payload)
      VALUES (${incidentId}, 'note', ${JSON.stringify({ by: user.name || user.email, action: "postmortem updated" })}::jsonb)
    `;
  });

  revalidatePath(`/incidents/${incidentId}`);
  return { ok: true };
}
