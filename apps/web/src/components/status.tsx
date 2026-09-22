/**
 * Status vocabulary shared by the authenticated dashboard and the public status page.
 *
 * These are the pieces that carry meaning rather than decoration, so they live
 * apart from `ui.tsx`: a status pill that renders the wrong colour is a
 * correctness bug, not a styling nit.
 */
import type { MonitorStatus } from "@sentinel/shared";
import { statusLabel } from "@sentinel/shared";
import { cn, formatMs, formatPercent } from "@/lib/utils";

const STATUS_STYLES: Record<MonitorStatus, { dot: string; text: string; ring: string; bg: string }> = {
  UP: { dot: "bg-up", text: "text-up", ring: "ring-up/25", bg: "bg-up/10" },
  DEGRADED: { dot: "bg-degraded", text: "text-degraded", ring: "ring-degraded/25", bg: "bg-degraded/10" },
  PARTIAL_OUTAGE: { dot: "bg-partial", text: "text-partial", ring: "ring-partial/25", bg: "bg-partial/10" },
  DOWN: { dot: "bg-down", text: "text-down", ring: "ring-down/25", bg: "bg-down/10" },
  PAUSED: { dot: "bg-paused", text: "text-paused", ring: "ring-paused/25", bg: "bg-paused/10" },
  INCONCLUSIVE: { dot: "bg-inconclusive", text: "text-inconclusive", ring: "ring-inconclusive/25", bg: "bg-inconclusive/10" },
  PENDING: { dot: "bg-pending", text: "text-pending", ring: "ring-pending/25", bg: "bg-pending/10" },
};

export function StatusPill({
  status,
  size = "md",
  pulse,
  className,
}: {
  status: MonitorStatus;
  size?: "sm" | "md";
  pulse?: boolean;
  className?: string;
}) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset",
        s.text,
        s.ring,
        s.bg,
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        className,
      )}
    >
      <span className={cn("relative size-1.5 rounded-full", s.dot, pulse && "pulse-dot")} />
      {statusLabel(status)}
    </span>
  );
}

export function StatusDot({ status, className }: { status: MonitorStatus; className?: string }) {
  return <span className={cn("inline-block size-2 rounded-full", STATUS_STYLES[status].dot, className)} />;
}

export type UptimeSlot = {
  /** ISO day (YYYY-MM-DD) shown in the tooltip. */
  day: string;
  /** 0..1, or null when no data was collected for the slot. */
  uptime: number | null;
  /** Optional latency to surface alongside the percentage. */
  p95Ms?: number | null;
};

/**
 * The 90-slot uptime bar.
 *
 * Colour thresholds are deliberately coarse: perfect, a scratch, a wound, an
 * outage. Fine-grained gradients read as noise at 4px wide, and the eye is
 * being asked to find the bad day, not to read a value.
 */
function slotColor(uptime: number | null): string {
  if (uptime === null) return "bg-line-strong";
  if (uptime >= 0.9995) return "bg-up";
  if (uptime >= 0.99) return "bg-up/70";
  if (uptime >= 0.95) return "bg-degraded";
  if (uptime >= 0.8) return "bg-partial";
  return "bg-down";
}

export function UptimeBar({
  slots,
  className,
  slotClassName,
}: {
  slots: UptimeSlot[];
  className?: string;
  slotClassName?: string;
}) {
  return (
    <div className={cn("flex h-8 items-end gap-[2px]", className)}>
      {slots.map((slot, i) => (
        <div
          key={`${slot.day}-${i}`}
          className={cn("uptime-slot group relative h-full min-w-[3px] flex-1 rounded-[2px]", slotColor(slot.uptime), slotClassName)}
          title={
            slot.uptime === null
              ? `${slot.day} — no data`
              : `${slot.day} — ${formatPercent(slot.uptime * 100, 2)}${
                  slot.p95Ms != null ? ` · p95 ${formatMs(slot.p95Ms)}` : ""
                }`
          }
        >
          <span className="sr-only">
            {slot.day}: {slot.uptime === null ? "no data" : `${formatPercent(slot.uptime * 100, 2)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function UptimeLegend({ days, className }: { days: number; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between text-[11px] text-ink-3", className)}>
      <span>{days} days ago</span>
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-up" /> operational
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-degraded" /> degraded
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-down" /> outage
        </span>
      </span>
      <span>today</span>
    </div>
  );
}

export type RegionDot = {
  regionCode: string;
  city: string;
  ok: boolean | null;
  latencyMs: number | null;
  failureCode?: string | null;
};

/**
 * Per-region health dots.
 *
 * This is the single most information-dense element on the dashboard: it is how
 * a user distinguishes "my site is down" from "your probe in São Paulo is
 * having a bad day", which is the entire premise of multi-region consensus.
 */
export function RegionDots({ regions, className }: { regions: RegionDot[]; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {regions.map((r) => (
        <span
          key={r.regionCode}
          title={
            r.ok === null
              ? `${r.city} (${r.regionCode}) — no data`
              : r.ok
                ? `${r.city} (${r.regionCode}) — ok${r.latencyMs != null ? ` · ${formatMs(r.latencyMs)}` : ""}`
                : `${r.city} (${r.regionCode}) — ${r.failureCode ?? "failing"}`
          }
          className={cn(
            "size-2 rounded-full ring-1 ring-inset transition-transform hover:scale-150",
            r.ok === null && "bg-line-strong ring-line-strong",
            r.ok === true && "bg-up ring-up/40",
            r.ok === false && "bg-down ring-down/40",
          )}
        >
          <span className="sr-only">
            {r.city}: {r.ok === null ? "no data" : r.ok ? "ok" : "failing"}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The request waterfall: DNS → TCP → TLS → TTFB → transfer.
 *
 * Rendered as a stacked proportional bar rather than a chart library, because
 * the phases are strictly sequential and sum to the total — a stacked bar is
 * the honest encoding, and it costs no client JS.
 */
const PHASES = [
  { key: "dnsMs", label: "DNS", color: "bg-[#8b5cf6]", hint: "Name resolution" },
  { key: "tcpMs", label: "TCP", color: "bg-[#3b82f6]", hint: "Connection handshake" },
  { key: "tlsMs", label: "TLS", color: "bg-[#06b6d4]", hint: "Certificate negotiation" },
  { key: "ttfbMs", label: "TTFB", color: "bg-[#10b981]", hint: "Server think time" },
  { key: "transferMs", label: "Transfer", color: "bg-[#f59e0b]", hint: "Body download" },
] as const;

export type WaterfallTiming = {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  transferMs: number | null;
  totalMs: number;
};

export function Waterfall({ timing, className }: { timing: WaterfallTiming; className?: string }) {
  const segments = PHASES.map((p) => ({ ...p, value: timing[p.key] ?? 0 })).filter((p) => p.value > 0);
  const sum = segments.reduce((acc, s) => acc + s.value, 0);
  // Anything the phases do not account for (queueing, redirects) is shown
  // explicitly rather than silently rescaled away.
  const unaccounted = Math.max(0, timing.totalMs - sum);
  const scale = sum + unaccounted || 1;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-3">
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("h-full transition-all", s.color)}
            style={{ width: `${(s.value / scale) * 100}%` }}
            title={`${s.label}: ${formatMs(s.value)}`}
          />
        ))}
        {unaccounted > 0 && (
          <div className="h-full bg-line-strong" style={{ width: `${(unaccounted / scale) * 100}%` }} title={`Other: ${formatMs(unaccounted)}`} />
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {PHASES.map((p) => {
          const value = timing[p.key];
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span className={cn("size-2 shrink-0 rounded-full", p.color)} />
              <div className="min-w-0">
                <dt className="truncate text-[11px] uppercase tracking-wide text-ink-3" title={p.hint}>
                  {p.label}
                </dt>
                <dd className="tnum text-sm text-ink">{value == null ? "—" : formatMs(value)}</dd>
              </div>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/**
 * Failure codes carry a phase; colouring by phase lets someone scanning a table
 * of failures see "all TLS" or "all DNS" without reading a single label.
 */
const PHASE_TONE: Record<string, string> = {
  dns: "text-[#8b5cf6] bg-[#8b5cf6]/10 ring-[#8b5cf6]/25",
  tcp: "text-[#3b82f6] bg-[#3b82f6]/10 ring-[#3b82f6]/25",
  tls: "text-[#06b6d4] bg-[#06b6d4]/10 ring-[#06b6d4]/25",
  http: "text-down bg-down/10 ring-down/25",
  assertion: "text-degraded bg-degraded/10 ring-degraded/25",
  heartbeat: "text-inconclusive bg-inconclusive/10 ring-inconclusive/25",
  policy: "text-ink-2 bg-surface-3 ring-line-strong",
};

export function FailureBadge({ code, phase, className }: { code: string; phase: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ring-1 ring-inset",
        PHASE_TONE[phase] ?? PHASE_TONE.policy,
        className,
      )}
    >
      {code}
    </span>
  );
}
