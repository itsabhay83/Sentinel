"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { MonitorStatus } from "@sentinel/shared";
import { RegionDots, StatusPill, UptimeBar } from "@/components/status";
import { Input } from "@/components/ui";
import type { DashboardMonitor } from "@/lib/queries";
import { cn, formatMs, formatPercent, relativeTime } from "@/lib/utils";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "down", label: "Failing" },
  { key: "degraded", label: "Degraded" },
  { key: "up", label: "Operational" },
  { key: "paused", label: "Paused" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matchesFilter(status: MonitorStatus, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "down":
      return status === "DOWN" || status === "PARTIAL_OUTAGE";
    case "degraded":
      return status === "DEGRADED";
    case "up":
      return status === "UP";
    case "paused":
      return status === "PAUSED";
  }
}

export function MonitorList({ monitors }: { monitors: DashboardMonitor[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: monitors.length, down: 0, degraded: 0, up: 0, paused: 0 };
    for (const m of monitors) {
      for (const f of FILTERS) if (f.key !== "all" && matchesFilter(m.status, f.key)) c[f.key]++;
    }
    return c;
  }, [monitors]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = monitors.filter((m) => {
      if (!matchesFilter(m.status, filter)) return false;
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.url.toLowerCase().includes(q) ||
        (m.groupName ?? "").toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
    const map = new Map<string, DashboardMonitor[]>();
    for (const m of filtered) {
      const key = m.groupName ?? "Ungrouped";
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [monitors, query, filter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search monitors, URLs, tags…"
            className="pl-9"
            aria-label="Search monitors"
          />
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface/60 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                filter === f.key ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {f.label}
              <span className="tnum ml-1.5 text-ink-3">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface/40 p-12 text-center">
          <p className="text-sm text-ink-2">No monitors match that filter.</p>
        </div>
      )}

      {groups.map(([groupName, list]) => (
        <section key={groupName} className="space-y-2">
          <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-ink-3">
            {groupName} <span className="tnum ml-1 text-ink-3/70">{list.length}</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-line bg-surface/60">
            {list.map((m, i) => (
              <Link
                key={m.id}
                href={`/monitors/${m.id}`}
                className={cn(
                  "group grid grid-cols-1 gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/70 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] lg:items-center lg:gap-6",
                  i > 0 && "border-t border-line/70",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusPill status={m.status} size="sm" pulse={m.status === "DOWN" || m.status === "PARTIAL_OUTAGE"} />
                    <span className="truncate font-medium text-ink transition-colors group-hover:text-accent">{m.name}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-ink-3">{m.url}</p>
                </div>

                <div className="w-full lg:w-64">
                  <UptimeBar slots={m.days} className="h-7" />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
                    <span>90d</span>
                    <span className="tnum">{m.uptime30d == null ? "—" : `${formatPercent(m.uptime30d, 2)}`}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <RegionDots regions={m.regions} />
                  <span className="tnum w-16 text-right text-sm text-ink-2">{m.lastLatencyMs == null ? "—" : formatMs(m.lastLatencyMs)}</span>
                </div>

                <span className="hidden w-24 text-right text-xs text-ink-3 lg:block">
                  {m.lastCheckAt ? relativeTime(m.lastCheckAt) : "never"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
