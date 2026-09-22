import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, Lock } from "lucide-react";
import { asc, eq } from "drizzle-orm";
import { db, sql as rawSql } from "@sentinel/db";
import { monitors } from "@sentinel/db/schema";
import { StatusPageForm, StatusPagePassword } from "@/components/settings-forms";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { toggleStatusPageAction } from "@/lib/actions/status-pages";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";

export const metadata: Metadata = { title: "Status pages" };
export const dynamic = "force-dynamic";

export default async function StatusPagesSettings() {
  const { org } = await requireOrg();
  const [pages, monitorRows] = await Promise.all([
    rawSql<
      {
        id: string;
        slug: string;
        title: string;
        published: boolean;
        show_uptime_days: number;
        monitor_count: number;
        is_protected: boolean;
      }[]
    >`
      SELECT p.id, p.slug, p.title, p.published, p.show_uptime_days,
             p.password_hash IS NOT NULL AS is_protected,
             (SELECT count(*)::int FROM status_page_monitors WHERE status_page_id = p.id) AS monitor_count
      FROM status_pages p WHERE p.organization_id = ${org.id} ORDER BY p.created_at
    `,
    db.select({ id: monitors.id, name: monitors.name }).from(monitors).where(eq(monitors.organizationId, org.id)).orderBy(asc(monitors.name)),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Status pages</h1>
      <p className="mt-1 text-sm text-ink-2">
        Server-rendered and safe to hand to customers. Internal names and URLs are never exposed; add a password to
        restrict a page to people you share it with.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Your pages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pages.length === 0 && <p className="py-6 text-center text-sm text-ink-3">No status pages yet.</p>}
            {pages.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{p.title}</span>
                  <span className="block truncate font-mono text-xs text-ink-3">/status/{p.slug}</span>
                </span>
                <Badge tone={p.published ? "accent" : "neutral"}>{p.published ? "published" : "draft"}</Badge>
                {p.is_protected && (
                  <Badge tone="info">
                    <Lock className="size-3" /> private
                  </Badge>
                )}
                <span className="text-xs text-ink-3">{p.monitor_count} monitors</span>
                <Link
                  href={`/status/${p.slug}`}
                  target="_blank"
                  className="inline-flex items-center gap-1 text-xs text-accent transition-colors hover:text-ink"
                >
                  View <ExternalLink className="size-3" />
                </Link>
                <form action={toggleStatusPageAction.bind(null, p.id)}>
                  <Button type="submit" variant="ghost" size="sm">
                    {p.published ? "Unpublish" : "Publish"}
                  </Button>
                </form>
                <StatusPagePassword csrf={<CsrfInput />} pageId={p.id} isProtected={p.is_protected} />
              </div>
            ))}
          </CardContent>
        </Card>
        <StatusPageForm csrf={<CsrfInput />} monitors={monitorRows} />
      </div>
    </div>
  );
}
