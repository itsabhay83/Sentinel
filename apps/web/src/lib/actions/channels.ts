"use server";

/**
 * Alert channel CRUD.
 *
 * Channel configs hold Slack/Discord webhook URLs and HMAC secrets. They are
 * stored as jsonb rather than encrypted because the scheduler needs to read
 * them on every delivery and they are already scoped to the organization row —
 * a deliberate, recorded tradeoff, unlike monitor headers which carry the
 * customer's own production credentials and are encrypted. For the same reason
 * the audit metadata below records the channel's name and kind but never its
 * config.
 */
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@sentinel/db";
import { alertChannels } from "@sentinel/db/schema";
import { ALERT_CHANNEL_KINDS, limitsFor, type Plan } from "@sentinel/shared";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { guardRole, requireRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const ALERTS_PATH = "/settings/alerts";

const channelSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    kind: z.enum(ALERT_CHANNEL_KINDS),
    to: z.string().trim().max(320).optional().default(""),
    url: z.string().trim().max(2000).optional().default(""),
    secret: z.string().trim().max(200).optional().default(""),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "email" && !z.string().email().safeParse(v.to).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid destination email" });
    }
    if (v.kind !== "email" && !/^https:\/\//.test(v.url)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter an https:// webhook URL" });
    }
  });

export async function createChannelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = channelSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
    to: formData.get("to") ?? "",
    url: formData.get("url") ?? "",
    secret: formData.get("secret") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const existing = await db.select({ id: alertChannels.id }).from(alertChannels).where(eq(alertChannels.organizationId, org.id));
  const limits = limitsFor(org.plan as Plan);
  if (existing.length >= limits.maxAlertChannels) {
    return { error: `Your ${org.plan} plan allows ${limits.maxAlertChannels} alert channels.` };
  }

  const { name, kind, to, url, secret } = parsed.data;
  const config: Record<string, string> = kind === "email" ? { to } : secret ? { url, secret } : { url };

  const [row] = await db
    .insert(alertChannels)
    .values({ organizationId: org.id, name, kind, config })
    .returning({ id: alertChannels.id });

  await recordAudit({
    action: "alert_channel.created",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "alert_channel",
    targetId: row?.id ?? null,
    metadata: { name, kind, signed: kind !== "email" && secret.length > 0 },
  });

  revalidatePath(ALERTS_PATH);
  return { ok: true };
}

export async function deleteChannelAction(channelId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const [row] = await db
    .delete(alertChannels)
    .where(and(eq(alertChannels.id, channelId), eq(alertChannels.organizationId, org.id)))
    .returning({ id: alertChannels.id, name: alertChannels.name, kind: alertChannels.kind });
  if (!row) return;

  await recordAudit({
    action: "alert_channel.deleted",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "alert_channel",
    targetId: row.id,
    metadata: { name: row.name, kind: row.kind },
  });

  revalidatePath(ALERTS_PATH);
}
