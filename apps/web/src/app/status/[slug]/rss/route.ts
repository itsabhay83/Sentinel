import { getServerEnv } from "@sentinel/shared/env";
import { getPublishedMaintenance } from "@/lib/maintenance";
import { getStatusPage, getStatusPageAccess } from "@/lib/queries";
import { hasStatusPageGrant } from "@/lib/status-gate";

/** Minimal XML escaping — incident text is operator-authored and can contain angle brackets. */
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await getStatusPageAccess(slug);
  // A protected page's feed is the same incident history through a different
  // content type, so it answers to the same gate. 404 rather than 401: a feed
  // reader cannot complete a password form, and "not found" leaks nothing.
  if (!access || !(await hasStatusPageGrant(access.id, access.passwordHash))) {
    return new Response("Not found", { status: 404 });
  }

  const [page, maintenance] = await Promise.all([getStatusPage(slug), getPublishedMaintenance(slug)]);
  if (!page) return new Response("Not found", { status: 404 });

  const base = getServerEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const self = `${base}/status/${page.slug}`;

  const incidentItems = page.incidents
    .map((i) => {
      const title = `${i.resolvedAt ? "Resolved" : "Investigating"}: ${i.monitorName} — ${i.severity}`;
      // Dates arrive as ISO strings, not Date objects: `getStatusPage` is wrapped in
      // `unstable_cache`, so the payload is rehydrated through JSON. Always re-wrap
      // before calling a Date method here or the whole feed 500s.
      const description = i.events
        .map((e) => `${new Date(e.at).toISOString()} — ${e.kind.replace(/_/g, " ")}`)
        .join("\n");
      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(self)}</link>
      <guid isPermaLink="false">${esc(i.id)}</guid>
      <pubDate>${new Date(i.resolvedAt ?? i.startedAt).toUTCString()}</pubDate>
      <description>${esc(description)}</description>
    </item>`;
    })
    .join("\n");

  // Published maintenance is announcement, not history, so it carries a `maintenance-`
  // guid prefix: an incident and a window could otherwise collide on a shared uuid.
  const maintenanceItems = maintenance
    .map((w) => {
      const title = `${w.status === "in_progress" ? "Maintenance in progress" : "Scheduled maintenance"}: ${w.reason || "Planned work"}`;
      const description = [
        `${w.startsAt} — ${w.endsAt}`,
        w.services.length > 0 ? `Affects ${w.services.join(", ")}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(self)}</link>
      <guid isPermaLink="false">maintenance-${esc(w.id)}</guid>
      <pubDate>${new Date(w.startsAt).toUTCString()}</pubDate>
      <description>${esc(description)}</description>
    </item>`;
    })
    .join("\n");

  const items = [maintenanceItems, incidentItems].filter((block) => block !== "").join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(page.title)}</title>
    <link>${esc(self)}</link>
    <description>${esc(page.description ?? `Incident history for ${page.title}`)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // A protected feed must never land in a shared cache, where it would be
      // served to readers who never presented the password.
      "cache-control": access.passwordHash === null ? "public, max-age=60" : "private, no-store",
    },
  });
}
