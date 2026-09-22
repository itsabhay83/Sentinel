"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "@sentinel/db";
import { statusPages } from "@sentinel/db/schema";
import { limitsFor, type Plan } from "@sentinel/shared";
import { generateToken, hashPassword, slugify } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { STATUS_PAGE_CACHE_TAG } from "@/lib/queries";
import { guardRole, requireRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const PAGES_PATH = "/settings/status-pages";

const statusPageSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  slug: z.string().trim().min(1, "Slug is required").max(64),
  description: z.string().trim().max(500).optional().default(""),
  showUptimeDays: z.coerce.number().int().min(7).max(365).default(90),
  published: z.coerce.boolean().default(false),
  monitorIds: z.array(z.string().uuid()).default([]),
});

export async function createStatusPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = statusPageSchema.safeParse({
    title: formData.get("title"),
    slug: formData.get("slug"),
    description: formData.get("description") ?? "",
    showUptimeDays: formData.get("showUptimeDays") ?? 90,
    published: formData.get("published") === "on",
    monitorIds: formData.getAll("monitorIds").map(String),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const limits = limitsFor(org.plan as Plan);
  const existing = await db.select({ id: statusPages.id }).from(statusPages).where(eq(statusPages.organizationId, org.id));
  if (existing.length >= limits.maxStatusPages) {
    return { error: `Your ${org.plan} plan allows ${limits.maxStatusPages} status page(s).` };
  }

  const slug = slugify(parsed.data.slug);
  const taken = await db.select({ id: statusPages.id }).from(statusPages).where(eq(statusPages.slug, slug)).limit(1);
  if (taken.length > 0) return { error: "That slug is already taken" };

  const pageId = crypto.randomUUID();
  try {
    await rawSql.begin(async (tx) => {
      await tx`
        INSERT INTO status_pages (id, organization_id, slug, title, description, theme, show_uptime_days, published, domain_verification_token)
        VALUES (${pageId}, ${org.id}, ${slug}, ${parsed.data.title}, ${parsed.data.description || null},
                ${JSON.stringify({ accent: "#10b981", mode: "dark" })}::jsonb, ${parsed.data.showUptimeDays},
                ${parsed.data.published}, ${generateToken(16)})
      `;
      for (const [i, monitorId] of parsed.data.monitorIds.entries()) {
        await tx`
          INSERT INTO status_page_monitors (status_page_id, monitor_id, display_name, group_name, order_index)
          SELECT ${pageId}, m.id, m.name, coalesce(m.group_name, 'Services'), ${i}
          FROM monitors m WHERE m.id = ${monitorId} AND m.organization_id = ${org.id}
        `;
      }
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create the status page" };
  }

  await recordAudit({
    action: "status_page.created",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "status_page",
    targetId: pageId,
    metadata: { slug, title: parsed.data.title, published: parsed.data.published, monitors: parsed.data.monitorIds.length },
  });

  revalidatePath(PAGES_PATH);
  return { ok: true };
}

export async function toggleStatusPageAction(pageId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const [row] = await rawSql<{ id: string; slug: string; published: boolean }[]>`
    UPDATE status_pages SET published = NOT published
    WHERE id = ${pageId} AND organization_id = ${org.id}
    RETURNING id, slug, published
  `;
  if (!row) return;

  await recordAudit({
    action: "status_page.updated",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "status_page",
    targetId: row.id,
    metadata: { slug: row.slug, published: row.published },
  });

  revalidatePath(PAGES_PATH);
  revalidateTag(STATUS_PAGE_CACHE_TAG);
}

const statusPagePasswordSchema = z.object({
  pageId: z.string().uuid(),
  password: z.string().min(8, "Use at least 8 characters").max(200).or(z.literal("")),
});

/**
 * Setting an empty password makes the page public again. Because an outstanding
 * grant is an HMAC over the stored hash, writing a new hash — or NULL — is itself
 * the revocation: every cookie issued under the previous password stops verifying.
 */
export async function setStatusPagePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;
  const parsed = statusPagePasswordSchema.safeParse({
    pageId: formData.get("pageId"),
    password: formData.get("password") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const hash = parsed.data.password === "" ? null : await hashPassword(parsed.data.password);
  const updated = await rawSql<{ id: string; slug: string }[]>`
    UPDATE status_pages SET password_hash = ${hash}
    WHERE id = ${parsed.data.pageId} AND organization_id = ${org.id}
    RETURNING id, slug
  `;
  const row = updated[0];
  if (!row) return { error: "Status page not found" };

  await recordAudit({
    action: "status_page.password.changed",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "status_page",
    targetId: row.id,
    metadata: { slug: row.slug, protected: hash !== null },
  });

  revalidatePath(PAGES_PATH);
  revalidateTag(STATUS_PAGE_CACHE_TAG);
  return { ok: true };
}
