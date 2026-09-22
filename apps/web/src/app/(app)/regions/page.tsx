import type { Metadata } from "next";
import { RegionMap } from "@/components/charts";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { getRegionHealth } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Regions" };
export const dynamic = "force-dynamic";

export default async function RegionsPage() {
  await requireOrg();
  const regions = await getRegionHealth();
  const quarantined = regions.filter((r) => r.healthStatus === "quarantined");

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Probe regions</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        Sentinel excludes a region from quorum when it fails far more than its peers — that is a probe-side network fault, not your outage.
      </p>

      <div className="mt-6">
        <RegionMap
          regions={regions.map((r) => ({
            regionCode: r.code,
            city: r.city,
            country: r.country,
            lat: r.lat,
            lng: r.lng,
            ok: r.enabled ? r.healthStatus !== "quarantined" : null,
            latencyMs: null,
            quarantined: r.healthStatus === "quarantined",
          }))}
        />
      </div>

      {quarantined.length > 0 && (
        <Card className="mt-5 border-inconclusive/30">
          <CardHeader>
            <CardTitle className="text-inconclusive">Quarantined</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {quarantined.map((r) => (
              <p key={r.code} className="text-sm text-ink-2">
                <span className="font-medium text-ink">{r.city}</span> — {r.quarantineReason}
                {r.quarantinedUntil && <span className="text-ink-3"> · until {relativeTime(r.quarantinedUntil)}</span>}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="mt-5">
        <CardContent className="px-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-3">
                <th className="px-4 py-2 font-medium">Region</th>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Country</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr key={r.code} className="border-b border-line/50 last:border-0">
                  <td className="px-4 py-2.5 text-ink">{r.city}</td>
                  <td className="px-4 py-2.5 font-mono text-xs uppercase text-ink-3">{r.code}</td>
                  <td className="px-4 py-2.5 text-ink-2">{r.country}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={r.healthStatus === "healthy" ? "accent" : r.healthStatus === "quarantined" ? "info" : "warn"}>{r.healthStatus}</Badge>
                    {!r.enabled && <Badge tone="neutral" className="ml-2">disabled</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-ink-3">{r.lastSeenAt ? relativeTime(r.lastSeenAt) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
