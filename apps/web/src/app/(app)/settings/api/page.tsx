import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@sentinel/db";
import { apiKeys } from "@sentinel/db/schema";
import { ApiKeyForm, RotateKeyForm } from "@/components/api-key-forms";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { revokeApiKeyAction } from "@/lib/actions/api-keys";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;

type KeyLifecycle = { revokedAt: Date | null; expiresAt: Date | null };

function keyStatus(key: KeyLifecycle): { label: string; tone: "accent" | "warn" | "danger" } {
  if (key.revokedAt) return { label: "revoked", tone: "danger" };
  if (!key.expiresAt) return { label: "active", tone: "accent" };
  const msLeft = new Date(key.expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return { label: "expired", tone: "danger" };
  if (msLeft <= EXPIRING_SOON_MS) return { label: "expiring", tone: "warn" };
  return { label: "active", tone: "accent" };
}

export default async function ApiKeysPage() {
  const { org } = await requireOrg();
  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, org.id))
    .orderBy(desc(apiKeys.createdAt));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
      <p className="mt-1 text-sm text-ink-2">
        Authenticate with <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">Authorization: Bearer sk_live_…</code> against{" "}
        <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">/api/v1</code>. Rotating a key keeps the old
        one alive for 24 hours so callers can migrate without downtime.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Active keys</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {keys.length === 0 && <p className="py-6 text-center text-sm text-ink-3">No API keys yet.</p>}
            {keys.map((k) => {
              const status = keyStatus(k);
              const live = status.label !== "revoked" && status.label !== "expired";
              return (
                <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{k.name}</span>
                    <span className="block truncate font-mono text-xs text-ink-3">{k.keyPrefix}…</span>
                  </span>
                  <span className="hidden text-xs text-ink-3 sm:block">{k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : "never used"}</span>
                  <span className="hidden text-xs text-ink-3 sm:block">
                    {k.expiresAt ? `expires ${relativeTime(k.expiresAt)}` : "no expiry"}
                  </span>
                  <Badge tone="neutral">{(k.scopes ?? []).length} scopes</Badge>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {live && <RotateKeyForm csrf={<CsrfInput />} keyId={k.id} />}
                  {live && (
                    <form action={revokeApiKeyAction.bind(null, k.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Revoke
                      </Button>
                    </form>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
        <ApiKeyForm csrf={<CsrfInput />} />
      </div>
    </div>
  );
}
