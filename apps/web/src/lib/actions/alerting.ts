"use server";

/**
 * Escalation policies and maintenance windows.
 *
 * Both tables were already read by the scheduler but had no way to get rows
 * into them. Escalation policies are the more urgent of the two:
 * `queueIncidentAlert` joins monitor_policies -> escalation_steps ->
 * alert_channels with no fallback branch, so a monitor with no policy attached
 * receives no alert at all — not merely no escalation. Creating a channel is
 * therefore only half of a working alert path; the policy is the other half.
 */

import { revalidatePath } from "next/cache";
import { sql as rawSql } from "@sentinel/db";
import { z } from "zod";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { guardRole, requireRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const ALERTS_PATH = "/settings/alerts";

const uuidList = z.array(z.string().uuid());

const maintenanceSchema = z.object({
  reason: z.string().trim().max(200).default(""),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  // The suppression query is `monitor_id = ANY(mw.monitor_ids)`, so an empty
  // array suppresses nothing. Requiring a selection avoids shipping a window
  // that silently does nothing.
  monitorIds: uuidList.min(1, "Pick at least one monitor to suppress"),
});

export async function createMaintenanceWindowAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org } = guard;
  const parsed = maintenanceSchema.safeParse({
    reason: formData.get("reason") ?? "",
    startsAt: formData.get("startsAt"),
    endsAt: formData.get("endsAt"),
    monitorIds: formData.getAll("monitorIds").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { reason, startsAt, endsAt, monitorIds } = parsed.data;
  if (endsAt <= startsAt) {
    return { error: "The window must end after it starts" };
  }

  // Filtering the ids through the org's own monitors means a tampered form
  // cannot attach someone else's monitor to this window.
  const owned = await rawSql<{ id: string }[]>`
    SELECT id FROM monitors WHERE organization_id = ${org.id} AND id = ANY(${monitorIds}::uuid[])
  `;
  if (owned.length === 0) {
    return { error: "Pick at least one monitor to suppress" };
  }

  // The timestamps go over as ISO strings with an explicit cast: postgres.js
  // cannot infer a parameter type once a neighbouring parameter carries an
  // explicit `::uuid[]` cast, and it then hands the raw Date to Buffer.
  await rawSql`
    INSERT INTO maintenance_windows (organization_id, monitor_ids, starts_at, ends_at, reason)
    VALUES (
      ${org.id},
      ${owned.map((m) => m.id)}::uuid[],
      ${startsAt.toISOString()}::timestamptz,
      ${endsAt.toISOString()}::timestamptz,
      ${reason}
    )
  `;
  revalidatePath(ALERTS_PATH);
  return { ok: true };
}

export async function deleteMaintenanceWindowAction(id: string): Promise<void> {
  await assertSameOrigin();

  const { org } = await requireRole("admin");
  await rawSql`DELETE FROM maintenance_windows WHERE id = ${id} AND organization_id = ${org.id}`;
  revalidatePath(ALERTS_PATH);
}

const policySchema = z.object({
  name: z.string().trim().min(1, "Name the policy").max(80),
  channelIds: uuidList.min(1, "Pick at least one channel for the first page"),
});

/**
 * Creates the policy together with its step 0 in one transaction. Step 0 is
 * what `queueIncidentAlert` uses for the open and resolve alerts, so a policy
 * without it would be inert — there is no useful intermediate state to save.
 */
export async function createEscalationPolicyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org } = guard;
  const parsed = policySchema.safeParse({
    name: formData.get("name"),
    channelIds: formData.getAll("channelIds").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, channelIds } = parsed.data;

  const owned = await rawSql<{ id: string }[]>`
    SELECT id FROM alert_channels WHERE organization_id = ${org.id} AND id = ANY(${channelIds}::uuid[])
  `;
  if (owned.length === 0) {
    return { error: "Pick at least one channel for the first page" };
  }

  await rawSql.begin(async (tx) => {
    const [policy] = await tx<{ id: string }[]>`
      INSERT INTO escalation_policies (organization_id, name) VALUES (${org.id}, ${name}) RETURNING id
    `;
    await tx`
      INSERT INTO escalation_steps (policy_id, order_index, after_minutes, channel_ids)
      VALUES (${policy!.id}, 0, 0, ${owned.map((c) => c.id)}::uuid[])
    `;
  });
  revalidatePath(ALERTS_PATH);
  return { ok: true };
}

export async function deleteEscalationPolicyAction(id: string): Promise<void> {
  await assertSameOrigin();

  const { org } = await requireRole("admin");
  await rawSql`DELETE FROM escalation_policies WHERE id = ${id} AND organization_id = ${org.id}`;
  revalidatePath(ALERTS_PATH);
}

const stepSchema = z.object({
  policyId: z.string().uuid(),
  afterMinutes: z.coerce.number().int().min(1, "Escalate at least a minute later").max(1440),
  channelIds: uuidList.min(1, "Pick at least one channel"),
});

export async function addEscalationStepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org } = guard;
  const parsed = stepSchema.safeParse({
    policyId: formData.get("policyId"),
    afterMinutes: formData.get("afterMinutes"),
    channelIds: formData.getAll("channelIds").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { policyId, afterMinutes, channelIds } = parsed.data;

  const [policy] = await rawSql<{ id: string }[]>`
    SELECT id FROM escalation_policies WHERE id = ${policyId} AND organization_id = ${org.id}
  `;
  if (!policy) return { error: "Policy not found" };

  const owned = await rawSql<{ id: string }[]>`
    SELECT id FROM alert_channels WHERE organization_id = ${org.id} AND id = ANY(${channelIds}::uuid[])
  `;
  if (owned.length === 0) return { error: "Pick at least one channel" };

  // order_index is both the step's position and the dedup key in
  // alert_deliveries, so it has to be unique within the policy.
  await rawSql`
    INSERT INTO escalation_steps (policy_id, order_index, after_minutes, channel_ids)
    SELECT ${policyId}, coalesce(max(order_index), 0) + 1, ${afterMinutes}, ${owned.map((c) => c.id)}::uuid[]
    FROM escalation_steps WHERE policy_id = ${policyId}
  `;
  revalidatePath(ALERTS_PATH);
  return { ok: true };
}

export async function deleteEscalationStepAction(stepId: string): Promise<void> {
  await assertSameOrigin();

  const { org } = await requireRole("admin");
  await rawSql`
    DELETE FROM escalation_steps s
    USING escalation_policies p
    WHERE s.id = ${stepId} AND s.policy_id = p.id AND p.organization_id = ${org.id}
      AND s.order_index > 0
  `;
  revalidatePath(ALERTS_PATH);
}

const assignSchema = z.object({
  policyId: z.string().uuid(),
  monitorIds: uuidList,
});

/**
 * Replaces the policy's monitor set wholesale. A monitor may belong to several
 * policies — the composite primary key allows it — so this only clears rows for
 * this policy and leaves other policies' assignments alone.
 */
export async function setPolicyMonitorsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org } = guard;
  const parsed = assignSchema.safeParse({
    policyId: formData.get("policyId"),
    monitorIds: formData.getAll("monitorIds").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { policyId, monitorIds } = parsed.data;

  const [policy] = await rawSql<{ id: string }[]>`
    SELECT id FROM escalation_policies WHERE id = ${policyId} AND organization_id = ${org.id}
  `;
  if (!policy) return { error: "Policy not found" };

  await rawSql.begin(async (tx) => {
    await tx`DELETE FROM monitor_policies WHERE policy_id = ${policyId}`;
    if (monitorIds.length > 0) {
      await tx`
        INSERT INTO monitor_policies (monitor_id, policy_id)
        SELECT m.id, ${policyId} FROM monitors m
        WHERE m.organization_id = ${org.id} AND m.id = ANY(${monitorIds}::uuid[])
      `;
    }
  });
  revalidatePath(ALERTS_PATH);
  return { ok: true };
}
