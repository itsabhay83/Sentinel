import {
  Cable,
  Globe,
  HeartPulse,
  Network,
  Radio,
  Rss,
  Target,
  Workflow,
} from "lucide-react";
import { ALERT_CHANNEL_KINDS, MONITOR_TYPES, type MonitorType } from "@sentinel/shared";

import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";
import { WorldMap } from "./world-map";

/**
 * The bento. Twelve columns on `lg`, six on `md`, one below that.
 *
 * Tile sizes are not decoration: the two features that need a picture to land —
 * the timing waterfall and the region map — get the width to draw one, and the
 * six that are a sentence and a proof get a card.
 */

/** Illustrative phase split for one Sydney check. Sums to the 612ms in the caption. */
const WATERFALL = [
  { phase: "dns", ms: 34 },
  { phase: "tcp", ms: 78 },
  { phase: "tls", ms: 340 },
  { phase: "ttfb", ms: 121 },
  { phase: "transfer", ms: 39 },
] as const;

const WATERFALL_TOTAL = WATERFALL.reduce((sum, row) => sum + row.ms, 0);

const TYPE_ICONS: Record<MonitorType, typeof Globe> = {
  http: Globe,
  tcp: Cable,
  ping: Radio,
  dns: Network,
  heartbeat: HeartPulse,
  flow: Workflow,
};

const TYPE_LABELS: Record<MonitorType, string> = {
  http: "HTTP",
  tcp: "TCP",
  ping: "ICMP",
  dns: "DNS",
  heartbeat: "Heartbeat",
  flow: "Flow",
};

const CHANNEL_LABELS: Record<(typeof ALERT_CHANNEL_KINDS)[number], string> = {
  email: "Email",
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
};

export function FeatureGrid() {
  return (
    <section id="product" aria-labelledby="features-title" className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
      <Reveal>
        <h2
          id="features-title"
          className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          Everything a check records
        </h2>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
          A probe returns more than up or down. Every phase is timed, every region is named, and every
          assertion that ran is on the row.
        </p>
      </Reveal>

      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-6 lg:grid-cols-12">
        <Tile className="md:col-span-6 lg:col-span-7" title="Phase-level timing waterfall" delayMs={0}>
          <p className="text-sm leading-relaxed text-ink-2">
            DNS, TCP, TLS, TTFB and transfer are recorded separately on every check.
            &ldquo;The site is slow&rdquo; becomes a layer with a number next to it.
          </p>
          <Waterfall />
          <p className="mt-4 font-mono text-[11px] text-ink-3">
            TLS negotiation costs 340ms from Sydney.
          </p>
        </Tile>

        <Tile className="md:col-span-6 lg:col-span-5" title="Six check types" delayMs={60}>
          <p className="text-sm leading-relaxed text-ink-2">
            One scheduler, one consensus rule, six ways to ask the question.
          </p>
          <ul className="mt-5 grid grid-cols-3 gap-2">
            {MONITOR_TYPES.map((type) => {
              const Icon = TYPE_ICONS[type];
              return (
                <li
                  key={type}
                  className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2 py-3"
                >
                  <Icon className="size-4 text-accent" aria-hidden />
                  <span className="font-mono text-[10px] text-ink-2">{TYPE_LABELS[type]}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            <code className="font-mono text-ink-2">heartbeat</code> inverts the direction — your cron job
            calls a token URL, and silence is the failure.
          </p>
        </Tile>

        <Tile className="md:col-span-6 lg:col-span-7" title="Eight probe regions" delayMs={120}>
          <p className="text-sm leading-relaxed text-ink-2">
            Mumbai, Singapore, Frankfurt, London, Virginia, California, São Paulo, Sydney. Each one votes;
            none of them decides.
          </p>
          <div className="mt-5 overflow-hidden rounded-lg border border-line bg-canvas/60 text-ink-3">
            <WorldMap />
          </div>
        </Tile>

        <Tile className="md:col-span-6 lg:col-span-5" title="Assertion engine" delayMs={180}>
          <p className="text-sm leading-relaxed text-ink-2">
            A 200 is not a passing check. Assert on the body, a JSONPath, a header, or the response time.
          </p>
          <pre className="mt-5 overflow-x-auto rounded-lg border border-line bg-canvas/70 p-4 font-mono text-[11px] leading-relaxed text-ink-2">
            <code>
              {`kind      jsonpath
target    $.database.status
operator  equals
value     `}
              <span className="text-accent">&quot;ready&quot;</span>
            </code>
          </pre>
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            Operators: <span className="font-mono">equals · not_equals · contains · not_contains · matches
            · lt · lte · gt · gte</span>
          </p>
        </Tile>

        <Tile className="md:col-span-3 lg:col-span-4" title="Region quarantine" delayMs={240}>
          <p className="text-sm leading-relaxed text-ink-2">
            A probe failing far more than its peers is a probe fault. Sentinel drops it from quorum instead
            of letting it poison every verdict.
          </p>
          <QuorumRing />
        </Tile>

        <Tile className="md:col-span-3 lg:col-span-4" title="Alert channels" delayMs={300}>
          <p className="text-sm leading-relaxed text-ink-2">
            Four destinations, one guarantee: exactly one alert per incident per channel.
          </p>
          <ul className="mt-5 space-y-2">
            {ALERT_CHANNEL_KINDS.map((kind) => (
              <li
                key={kind}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs text-ink-2"
              >
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                {CHANNEL_LABELS[kind]}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            Enforced by a unique database index, not by application logic — a retry storm cannot duplicate
            a page.
          </p>
        </Tile>

        <div className="grid gap-4 md:col-span-6 lg:col-span-4">
          <Tile title="SLOs and error budgets" icon={<Target className="size-4" aria-hidden />} delayMs={360}>
            <p className="text-sm leading-relaxed text-ink-2">
              Per-monitor objectives against a rolling window, defaulting to{" "}
              <span className="tnum font-mono text-ink">99.900%</span>.
            </p>
            <div className="mt-5">
              <div className="flex items-center justify-between font-mono text-[11px] text-ink-3">
                <span>error budget</span>
                <span className="tnum text-degraded">41% left</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line-strong">
                <div
                  className="sentinel-bar h-full rounded-full bg-degraded"
                  style={{ "--sentinel-bar-width": "41%" } as React.CSSProperties}
                />
              </div>
            </div>
          </Tile>

          <Tile title="Public status pages" icon={<Rss className="size-4" aria-hidden />} delayMs={420}>
            <p className="text-sm leading-relaxed text-ink-2">
              Custom slug, RSS feed, double-opt-in subscribers, published maintenance windows.
            </p>
            <div className="mt-5 rounded-lg border border-line bg-canvas/70 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
                  <span className="size-1.5 rounded-full bg-up" aria-hidden />
                  All systems operational
                </span>
                <Rss className="size-3 text-ink-3" aria-hidden />
              </div>
              <div className="mt-3 flex gap-px" aria-hidden>
                {Array.from({ length: 44 }, (_, index) => (
                  <span
                    key={index}
                    className={cn("h-5 flex-1 rounded-[1px]", index === 29 ? "bg-partial" : "bg-up/60")}
                  />
                ))}
              </div>
            </div>
          </Tile>
        </div>
      </div>
    </section>
  );
}

function Tile({
  title,
  icon,
  children,
  className,
  delayMs,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  delayMs: number;
}) {
  return (
    <Reveal className={className} delayMs={delayMs}>
      <div className="sentinel-card h-full rounded-xl border border-line bg-surface/60 p-6 backdrop-blur">
        <h3 className="flex items-center gap-2 text-base font-medium tracking-tight text-ink">
          {icon ? <span className="text-accent">{icon}</span> : null}
          {title}
        </h3>
        <div className="mt-3">{children}</div>
      </div>
    </Reveal>
  );
}

function Waterfall() {
  let offset = 0;

  return (
    <div className="mt-5 space-y-2">
      {WATERFALL.map((row) => {
        const left = (offset / WATERFALL_TOTAL) * 100;
        const width = (row.ms / WATERFALL_TOTAL) * 100;
        offset += row.ms;

        return (
          <div key={row.phase} className="flex items-center gap-3">
            <span className="w-16 shrink-0 font-mono text-[11px] text-ink-3">{row.phase}</span>
            {/* The track reserves the row's full height before anything animates,
                so the bars growing in cannot shift the caption below them. */}
            <div className="relative h-4 flex-1 rounded bg-surface-2">
              <div
                className="sentinel-bar absolute inset-y-0 rounded"
                style={
                  {
                    left: `${left}%`,
                    "--sentinel-bar-width": `${width}%`,
                    backgroundColor: row.phase === "tls" ? "var(--color-degraded)" : "var(--color-accent)",
                    opacity: row.phase === "tls" ? 1 : 0.55,
                  } as React.CSSProperties
                }
              />
            </div>
            <span className="tnum w-14 shrink-0 text-right font-mono text-[11px] text-ink-2">{row.ms}ms</span>
          </div>
        );
      })}
      <div className="flex items-center gap-3 border-t border-line pt-2">
        <span className="w-16 shrink-0 font-mono text-[11px] text-ink-3">total</span>
        <span className="flex-1" />
        <span className="tnum w-14 shrink-0 text-right font-mono text-[11px] text-ink">{WATERFALL_TOTAL}ms</span>
      </div>
    </div>
  );
}

/** Eight seats around a circle; one of them is dimmed out of the vote. */
function QuorumRing() {
  const quarantined = 6;

  return (
    <div className="mt-6 flex flex-col items-center gap-4">
      <svg viewBox="0 0 120 120" className="size-28" aria-hidden>
        <circle cx="60" cy="60" r="44" fill="none" stroke="var(--color-line)" strokeWidth="1" />
        {Array.from({ length: 8 }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2 - Math.PI / 2;
          const cx = 60 + Math.cos(angle) * 44;
          const cy = 60 + Math.sin(angle) * 44;
          const out = index === quarantined;
          return (
            <circle
              key={index}
              cx={cx}
              cy={cy}
              r={out ? 4 : 5}
              fill={out ? "var(--color-paused)" : "var(--color-accent)"}
              opacity={out ? 0.4 : 1}
            />
          );
        })}
        <text
          x="60"
          y="64"
          textAnchor="middle"
          className="fill-ink-2 font-mono"
          fontSize="13"
        >
          7/8
        </text>
      </svg>
      <p className="text-center font-mono text-[11px] text-ink-3">
        <span className="text-paused">gru</span> quarantined · quorum recomputed over 7
      </p>
    </div>
  );
}
