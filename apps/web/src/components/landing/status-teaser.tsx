import Link from "next/link";
import { ArrowRight, Rss } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";

/**
 * A mock, clearly framed as a mock by its browser chrome — the real one is a
 * click away, so there is nothing to gain by dressing this up as live data.
 *
 * The 90-day bars are generated from a fixed pattern rather than randomly: a
 * server and a client that disagree about which day was degraded would hydrate
 * into a mismatch.
 */
const DAYS = 90;
const DEGRADED_DAYS = new Set([23, 24, 61]);
const DOWN_DAYS = new Set([62]);

const ROWS = [
  { name: "API — checkout", uptime: "99.982%", tone: "up" as const },
  { name: "Web — marketing", uptime: "100.000%", tone: "up" as const },
  { name: "Postgres — primary", uptime: "99.997%", tone: "up" as const },
  { name: "Webhooks — delivery", uptime: "99.841%", tone: "degraded" as const },
];

export function StatusTeaser() {
  return (
    <section id="status" aria-labelledby="status-title" className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <Reveal>
          <h2
            id="status-title"
            className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            A status page that says which regions.
          </h2>
          <p className="mt-4 text-pretty leading-relaxed text-ink-2">
            Custom slug, RSS feed, and double-opt-in email subscribers with one-click unsubscribe tokens.
            Publish a maintenance window and it appears on the timeline before anyone files a ticket.
          </p>
          <Link
            href="/status/acme"
            className="sentinel-cta group mt-8 inline-flex items-center gap-2 text-sm font-medium text-accent transition-colors duration-150 hover:text-[#34d399]"
          >
            See the live one
            <ArrowRight className="sentinel-cta-arrow size-4" aria-hidden />
          </Link>
        </Reveal>

        <Reveal delayMs={120}>
          {/*
            Tilted at rest and flat on hover. `focus-within` matters as much as
            hover here — the mock contains a link, and a keyboard visitor should
            not have to read it through a 9-degree rotation.
          */}
          <div className="sentinel-tilt overflow-hidden rounded-xl border border-line bg-surface/70 backdrop-blur">
            <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-3">
              <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
              <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
              <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
              <span className="ml-2 truncate rounded bg-canvas/70 px-2 py-0.5 font-mono text-[10px] text-ink-3">
                sentinel.dev/status/acme
              </span>
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="pulse-dot relative size-2 rounded-full bg-up text-up" aria-hidden />
                  <span className="text-sm font-medium text-ink">All systems operational</span>
                </div>
                <Rss className="size-3.5 text-ink-3" aria-hidden />
              </div>

              <ul className="mt-6 space-y-5">
                {ROWS.map((row) => (
                  <li key={row.name}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-xs text-ink-2">{row.name}</span>
                      <span
                        className={cn(
                          "tnum shrink-0 font-mono text-[10px]",
                          row.tone === "up" ? "text-ink-3" : "text-degraded",
                        )}
                      >
                        {row.uptime}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-px" aria-hidden>
                      {Array.from({ length: DAYS }, (_, day) => (
                        <span
                          key={day}
                          className={cn(
                            "h-6 flex-1 rounded-[1px]",
                            DOWN_DAYS.has(day) && row.tone !== "up"
                              ? "bg-down"
                              : DEGRADED_DAYS.has(day) && row.tone !== "up"
                                ? "bg-degraded"
                                : "bg-up/55",
                          )}
                        />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-7 border-t border-line pt-5">
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-3">Incident timeline</p>
                <ol className="mt-3 space-y-2.5 text-[11px] leading-relaxed">
                  <li className="flex gap-3">
                    <span className="tnum w-11 shrink-0 font-mono text-ink-3">14:02</span>
                    <span className="text-ink-2">
                      Resolved — <span className="font-mono text-up">UP</span> confirmed from 8 regions
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="tnum w-11 shrink-0 font-mono text-ink-3">13:47</span>
                    <span className="text-ink-2">
                      Escalated — on-call rotation paged
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="tnum w-11 shrink-0 font-mono text-ink-3">13:41</span>
                    <span className="text-ink-2">
                      Opened — <span className="font-mono text-down">DOWN</span>, 6 of 8 regions agree
                    </span>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
