"use server";

/**
 * Monitor CRUD.
 *
 * Two things here are load-bearing beyond ordinary form handling:
 *
 *  1. Creating a monitor also inserts its `monitor_state` row with
 *     `next_run_at = now()`. That row is what the scheduler's claim query reads;
 *     without it a monitor is configured but invisible to the dispatch loop, and
 *     the user watches an empty page forever.
 *
 *  2. Headers and request bodies are encrypted before they touch the database.
 *     Monitors routinely carry bearer tokens, and those must not be readable
 *     from a database dump or a Redis AOF file.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db, sql as rawSql } from "@sentinel/db";
import { assertions, monitorRegions, monitorState, monitors } from "@sentinel/db/schema";
import { limitsFor, type Plan } from "@sentinel/shared";
import { encryptJson } from "@sentinel/shared/server";
import { getServerEnv } from "@sentinel/shared/env";
import { recordAudit } from "@/lib/audit";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import {
  describeChanges,
  parseHeaderLines,
  readAssertions,
  readForm,
  validateAgainstPlan,
} from "@/lib/monitor-form";
import { checkPlanRateLimit, retryAfterMessage } from "@/lib/ratelimit";
import { guardRole, requireRole } from "@/lib/rbac";

export type ActionState = { error?: string } | undefined;

export async function createMonitorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("member");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const input = parsed.data;

  const rate = await checkPlanRateLimit("monitorCreate", org.id, limitsFor(org.plan as Plan).monitorCreationsPerHour);
  if (!rate.allowed) return { error: retryAfterMessage(rate) };

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(monitors)
    .where(eq(monitors.organizationId, org.id));
  const planError = validateAgainstPlan(org.plan as Plan, input, countRow?.count ?? 0, true);
  if (planError) return { error: planError };

  const key = getServerEnv().ENCRYPTION_KEY;
  const headerMap = parseHeaderLines(input.headers);
  const monitorId = crypto.randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(monitors).values({
        id: monitorId,
        organizationId: org.id,
        name: input.name,
        type: input.type,
        url: input.url,
        method: input.method,
        headersEncrypted: Object.keys(headerMap).length > 0 ? encryptJson(headerMap, key) : null,
        bodyEncrypted: input.body.trim() ? encryptJson({ value: input.body }, key) : null,
        intervalSeconds: input.intervalSeconds,
        timeoutMs: input.timeoutMs,
        followRedirects: input.followRedirects,
        maxRedirects: input.maxRedirects,
        expectedStatusCodes: input.expectedStatusCodes,
        quorumRatio: input.quorumRatio.toFixed(2),
        minRegionsRequired: Math.min(input.minRegionsRequired, input.regions.length),
        confirmationFailures: input.confirmationFailures,
        confirmationSuccesses: input.confirmationSuccesses,
        degradedThresholdMs: input.degradedThresholdMs,
        tags: input.tags,
        groupName: input.groupName || null,
        paused: false,
      });
      await tx.insert(monitorRegions).values(input.regions.map((regionCode) => ({ monitorId, regionCode, enabled: true })));
      const rows = readAssertions(formData);
      if (rows.length > 0) {
        await tx.insert(assertions).values(rows.map((a) => ({ ...a, monitorId })));
      }
      // next_run_at = now() so the very next scheduler tick dispatches it.
      await tx.insert(monitorState).values({ monitorId, status: "PENDING", since: new Date(), nextRunAt: new Date() });
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create the monitor" };
  }

  await recordAudit({
    action: "monitor.created",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "monitor",
    targetId: monitorId,
    metadata: { name: input.name, type: input.type, intervalSeconds: input.intervalSeconds, regions: input.regions },
  });

  revalidatePath("/dashboard");
  redirect(`/monitors/${monitorId}`);
}

export async function updateMonitorAction(monitorId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("member");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const input = parsed.data;

  const planError = validateAgainstPlan(org.plan as Plan, input, 0, false);
  if (planError) return { error: planError };

  const owned = await db
    .select({ name: monitors.name, url: monitors.url, intervalSeconds: monitors.intervalSeconds })
    .from(monitors)
    .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, org.id)))
    .limit(1);
  const before = owned[0];
  if (!before) return { error: "Monitor not found" };

  const key = getServerEnv().ENCRYPTION_KEY;
  const headerMap = parseHeaderLines(input.headers);

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(monitors)
        .set({
          name: input.name,
          type: input.type,
          url: input.url,
          method: input.method,
          headersEncrypted: Object.keys(headerMap).length > 0 ? encryptJson(headerMap, key) : null,
          bodyEncrypted: input.body.trim() ? encryptJson({ value: input.body }, key) : null,
          intervalSeconds: input.intervalSeconds,
          timeoutMs: input.timeoutMs,
          followRedirects: input.followRedirects,
          maxRedirects: input.maxRedirects,
          expectedStatusCodes: input.expectedStatusCodes,
          quorumRatio: input.quorumRatio.toFixed(2),
          minRegionsRequired: Math.min(input.minRegionsRequired, input.regions.length),
          confirmationFailures: input.confirmationFailures,
          confirmationSuccesses: input.confirmationSuccesses,
          degradedThresholdMs: input.degradedThresholdMs,
          tags: input.tags,
          groupName: input.groupName || null,
          updatedAt: new Date(),
        })
        .where(eq(monitors.id, monitorId));

      await tx.delete(monitorRegions).where(eq(monitorRegions.monitorId, monitorId));
      await tx.insert(monitorRegions).values(input.regions.map((regionCode) => ({ monitorId, regionCode, enabled: true })));

      await tx.delete(assertions).where(eq(assertions.monitorId, monitorId));
      const rows = readAssertions(formData);
      if (rows.length > 0) await tx.insert(assertions).values(rows.map((a) => ({ ...a, monitorId })));
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not update the monitor" };
  }

  await recordAudit({
    action: "monitor.updated",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "monitor",
    targetId: monitorId,
    metadata: describeChanges(before, input),
  });

  revalidatePath(`/monitors/${monitorId}`);
  revalidatePath("/dashboard");
  redirect(`/monitors/${monitorId}`);
}

export async function togglePauseAction(monitorId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("member");
  const [row] = await rawSql<{ name: string; paused: boolean }[]>`
    UPDATE monitors SET paused = NOT paused, updated_at = now()
    WHERE id = ${monitorId} AND organization_id = ${org.id}
    RETURNING name, paused
  `;
  // Resuming must also re-arm the schedule; otherwise next_run_at stays in the
  // past and the monitor fires a burst of catch-up checks on resume.
  await rawSql`
    UPDATE monitor_state s SET next_run_at = now(), status = 'PENDING', since = now()
    FROM monitors m
    WHERE s.monitor_id = m.id AND m.id = ${monitorId} AND m.organization_id = ${org.id} AND m.paused = false
  `;

  if (row) {
    await recordAudit({
      action: row.paused ? "monitor.paused" : "monitor.resumed",
      organizationId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "monitor",
      targetId: monitorId,
      metadata: { name: row.name },
    });
  }

  revalidatePath("/dashboard");
  revalidatePath(`/monitors/${monitorId}`);
}

export async function deleteMonitorAction(monitorId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("member");
  const [row] = await db
    .delete(monitors)
    .where(and(eq(monitors.id, monitorId), eq(monitors.organizationId, org.id)))
    .returning({ name: monitors.name, url: monitors.url });

  if (row) {
    await recordAudit({
      action: "monitor.deleted",
      organizationId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "monitor",
      targetId: monitorId,
      metadata: { name: row.name, url: row.url },
    });
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/** Forces an immediate check cycle by pulling `next_run_at` back to now. */
export async function runNowAction(monitorId: string): Promise<void> {
  await assertSameOrigin();

  const { org } = await requireRole("member");
  await rawSql`
    UPDATE monitor_state s SET next_run_at = now()
    FROM monitors m
    WHERE s.monitor_id = m.id AND m.id = ${monitorId} AND m.organization_id = ${org.id}
  `;
  revalidatePath(`/monitors/${monitorId}`);
}
