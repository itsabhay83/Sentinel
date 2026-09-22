"use server";

/**
 * API key lifecycle: create, revoke, rotate.
 *
 * Revocation is a soft `revoked_at` write rather than a DELETE. The audit trail
 * references the key row, and a hard delete would erase who was calling the API
 * with it — precisely the question an incident review asks.
 */
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@sentinel/db";
import { apiKeys } from "@sentinel/db/schema";
import { getServerEnv } from "@sentinel/shared/env";
import { generateApiKey } from "@sentinel/shared/server";
import { z } from "zod";
import {
  DEFAULT_API_SCOPES,
  EXPIRY_DAYS,
  expiryFromDays,
  isApiScope,
  type ApiScope,
} from "@/lib/api-key-options";
import { recordAudit } from "@/lib/audit";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { guardRole, requireRole } from "@/lib/rbac";
import type { ActionState } from "@/lib/actions/settings";

const API_PATH = "/settings/api";

/** Long enough for a deploy pipeline to pick up the successor key. */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  expiresInDays: z.enum(EXPIRY_DAYS).default("0"),
});

const rotateSchema = z.object({ keyId: z.string().uuid() });

interface NewKey {
  organizationId: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  rotatedFromId?: string;
}

async function issueKey(input: NewKey): Promise<{ id: string; key: string }> {
  const { key, hashed } = generateApiKey(getServerEnv().API_KEY_HMAC_SECRET);
  const [row] = await db
    .insert(apiKeys)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      hashedKey: hashed,
      keyPrefix: key.slice(0, 16),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      rotatedFromId: input.rotatedFromId ?? null,
    })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error("Could not create the API key");
  return { id: row.id, key };
}

function readScopes(formData: FormData): ApiScope[] {
  const selected = formData.getAll("scopes").map(String).filter(isApiScope);
  return selected.length > 0 ? selected : [...DEFAULT_API_SCOPES];
}

/**
 * API keys are shown exactly once. Only the hash is stored, so a lost key
 * cannot be recovered — it can only be rotated.
 */
export async function createApiKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    expiresInDays: formData.get("expiresInDays") ?? "0",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const scopes = readScopes(formData);
  const { id, key } = await issueKey({
    organizationId: org.id,
    name: parsed.data.name,
    scopes,
    expiresAt: expiryFromDays(parsed.data.expiresInDays),
  });

  await recordAudit({
    action: "api_key.created",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "api_key",
    targetId: id,
    metadata: { name: parsed.data.name, scopes, expiresInDays: Number(parsed.data.expiresInDays) },
  });

  revalidatePath(API_PATH);
  return { ok: true, secret: key };
}

export async function revokeApiKeyAction(keyId: string): Promise<void> {
  await assertSameOrigin();

  const { org, user } = await requireRole("admin");
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, org.id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, name: apiKeys.name });
  if (!row) return;

  await recordAudit({
    action: "api_key.revoked",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "api_key",
    targetId: row.id,
    metadata: { name: row.name },
  });

  revalidatePath(API_PATH);
}

/**
 * Mints a successor carrying the same scopes and puts the predecessor on a 24h
 * fuse instead of killing it outright. That overlap is the point of rotation:
 * every caller still holding the old key keeps working until it has redeployed.
 */
export async function rotateApiKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const guard = await guardRole("admin");
  if (!guard.ok) return { error: guard.error };
  const { org, user } = guard;

  const parsed = rotateSchema.safeParse({ keyId: formData.get("keyId") });
  if (!parsed.success) return { error: "Invalid input" };

  const [current] = await db
    .select({ id: apiKeys.id, name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.id, parsed.data.keyId), eq(apiKeys.organizationId, org.id), isNull(apiKeys.revokedAt)),
    )
    .limit(1);
  if (!current) return { error: "API key not found" };

  const scopes = current.scopes.filter(isApiScope);
  const { id, key } = await issueKey({
    organizationId: org.id,
    name: current.name,
    scopes,
    expiresAt: null,
    rotatedFromId: current.id,
  });

  await db
    .update(apiKeys)
    .set({ expiresAt: new Date(Date.now() + ROTATION_GRACE_MS) })
    .where(and(eq(apiKeys.id, current.id), eq(apiKeys.organizationId, org.id)));

  await recordAudit({
    action: "api_key.rotated",
    organizationId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    targetType: "api_key",
    targetId: id,
    metadata: { name: current.name, rotatedFromId: current.id, graceHours: ROTATION_GRACE_MS / 3_600_000 },
  });

  revalidatePath(API_PATH);
  return { ok: true, secret: key };
}
