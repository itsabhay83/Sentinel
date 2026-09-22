"use client";

import { REGIONS } from "@sentinel/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";

export type RegionsCardProps = {
  regions: string[];
  quorumRatio: number;
  onToggleRegion: (code: string) => void;
};

export function RegionsCard({ regions, quorumRatio, onToggleRegion }: RegionsCardProps) {
  const quorumCount = Math.max(1, Math.ceil(regions.length * quorumRatio));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regions</CardTitle>
        <CardDescription>
          {regions.length} selected · {quorumCount} must agree before an incident opens.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {REGIONS.map((r) => {
            const checked = regions.includes(r.code);
            return (
              <label
                key={r.code}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                  checked ? "border-accent/40 bg-accent/[0.07] text-ink" : "border-line bg-surface-2/60 text-ink-2 hover:border-line-strong",
                )}
              >
                <input type="checkbox" name="regions" value={r.code} checked={checked} onChange={() => onToggleRegion(r.code)} className="sr-only" />
                <span className={cn("size-2 rounded-full", checked ? "bg-accent" : "bg-line-strong")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.city}</span>
                  <span className="block truncate font-mono text-[10px] uppercase text-ink-3">{r.code}</span>
                </span>
              </label>
            );
          })}
        </div>
        {regions.length === 0 && <p className="mt-3 text-sm text-down">Select at least one region.</p>}
      </CardContent>
    </Card>
  );
}
