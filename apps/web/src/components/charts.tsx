"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { REGIONS } from "@sentinel/shared";
import type { LatencyPoint } from "@/lib/queries";
import { cn, formatMs } from "@/lib/utils";

/** Distinct hues per region — deliberately not the status palette, which means something else. */
const REGION_COLORS: Record<string, string> = {
  bom: "#f97316",
  sin: "#eab308",
  fra: "#10b981",
  lhr: "#22d3ee",
  iad: "#3b82f6",
  sjc: "#8b5cf6",
  gru: "#ec4899",
  syd: "#14b8a6",
};

export function LatencyChart({ points, height = 260 }: { points: LatencyPoint[]; height?: number }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { data, regions } = useMemo(() => {
    const byBucket = new Map<string, Record<string, number | string | null>>();
    const seen = new Set<string>();
    for (const p of points) {
      seen.add(p.regionCode);
      const row = byBucket.get(p.bucket) ?? { bucket: p.bucket };
      row[p.regionCode] = p.p95;
      byBucket.set(p.bucket, row);
    }
    return {
      data: [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
      regions: [...seen].sort(),
    };
  }, [points]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-line-strong text-sm text-ink-3" style={{ height }}>
        No latency data in this window yet.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {regions.map((code) => {
          const off = hidden.has(code);
          return (
            <button
              key={code}
              type="button"
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(code)) next.delete(code);
                  else next.add(code);
                  return next;
                })
              }
              className={cn("flex items-center gap-1.5 text-xs transition-opacity", off ? "opacity-35" : "opacity-100")}
            >
              <span className="size-2 rounded-full" style={{ background: REGION_COLORS[code] ?? "#94a3b8" }} />
              <span className="text-ink-2">{REGIONS.find((r) => r.code === code)?.city ?? code}</span>
            </button>
          );
        })}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="#1f2430" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={{ fill: "#6b7488", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2430" }}
            minTickGap={48}
            tickFormatter={(v: string) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          />
          <YAxis tick={{ fill: "#6b7488", fontSize: 11 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => `${v}ms`} />
          <Tooltip
            contentStyle={{ background: "#12151c", border: "1px solid #2b3242", borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: "#a2abbd" }}
            labelFormatter={(v: string) => new Date(v).toLocaleString()}
            formatter={(value: number, name: string) => [formatMs(value), REGIONS.find((r) => r.code === name)?.city ?? name]}
          />
          {regions
            .filter((c) => !hidden.has(c))
            .map((code) => (
              <Line
                key={code}
                type="monotone"
                dataKey={code}
                stroke={REGION_COLORS[code] ?? "#94a3b8"}
                strokeWidth={1.75}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Region map.
 *
 * An equirectangular SVG projection rather than maplibre-gl: the map exists to
 * answer "which continents are unhappy", it never needs to pan, zoom, or resolve
 * a street — and a tile-server dependency would make the page fail offline and
 * on a locked-down network. The projection is exact, so the dots land where the
 * cities actually are.
 */
export function RegionMap({
  regions,
  className,
}: {
  regions: { regionCode: string; city: string; country: string; lat: number; lng: number; ok: boolean | null; latencyMs: number | null; quarantined?: boolean }[];
  className?: string;
}) {
  const W = 720;
  const H = 360;
  const project = (lat: number, lng: number) => ({ x: ((lng + 180) / 360) * W, y: ((90 - lat) / 180) * H });

  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-line bg-surface-2/50", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Probe regions">
        <defs>
          <radialGradient id="glow-up">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="glow-down">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </radialGradient>
          <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="#2b3242" />
          </pattern>
        </defs>

        <rect width={W} height={H} fill="url(#dots)" opacity="0.7" />

        {/* Graticule gives the dots a spatial frame without shipping a basemap. */}
        {[-60, -30, 0, 30, 60].map((lat) => (
          <line key={lat} x1={0} x2={W} y1={project(lat, 0).y} y2={project(lat, 0).y} stroke="#1f2430" strokeWidth={lat === 0 ? 1 : 0.5} />
        ))}
        {[-120, -60, 0, 60, 120].map((lng) => (
          <line key={lng} y1={0} y2={H} x1={project(0, lng).x} x2={project(0, lng).x} stroke="#1f2430" strokeWidth={0.5} />
        ))}

        {regions.map((r) => {
          const { x, y } = project(r.lat, r.lng);
          const tone = r.ok === false ? "#ef4444" : r.quarantined ? "#8b5cf6" : r.ok === null ? "#6b7488" : "#10b981";
          return (
            <g key={r.regionCode}>
              <circle cx={x} cy={y} r={26} fill={r.ok === false ? "url(#glow-down)" : "url(#glow-up)"} />
              <circle cx={x} cy={y} r={4.5} fill={tone} stroke="#08090c" strokeWidth={1.5} />
              {r.ok === false && (
                <circle cx={x} cy={y} r={4.5} fill="none" stroke={tone} strokeWidth={1}>
                  <animate attributeName="r" values="5;18" dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.7;0" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              <text x={x} y={y - 11} textAnchor="middle" fill="#a2abbd" fontSize="9.5" fontFamily="ui-sans-serif, system-ui">
                {r.city}
              </text>
              <text x={x} y={y + 17} textAnchor="middle" fill="#6b7488" fontSize="8.5" fontFamily="ui-monospace, monospace">
                {r.latencyMs == null ? "—" : formatMs(r.latencyMs)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
