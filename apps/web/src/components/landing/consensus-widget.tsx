"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_CONSENSUS, evaluateConsensus, REGIONS, type RegionCode } from "@sentinel/shared";

import { cn } from "@/lib/utils";

/**
 * The hero's teaching device: six seconds of animation that explain the quorum
 * rule without asking anyone to read prose.
 *
 * The verdict is not scripted — each frame is fed through the same
 * `evaluateConsensus()` the scheduler uses, so the pill can never drift from
 * the product's actual decision. Change `quorumRatio` in the shared package and
 * this widget starts teaching the new rule.
 *
 * Latencies are an illustrative fixture, not measurements: there is no live
 * probe behind a marketing page. They are fixed rather than random so the
 * server and client render the same markup.
 */
const DEMO_LATENCY_MS: Record<RegionCode, number> = {
  bom: 128,
  sin: 96,
  fra: 41,
  lhr: 38,
  iad: 22,
  sjc: 61,
  gru: 184,
  syd: 212,
};

/** The cascade order: a far-edge transit fault that spreads into a real outage. */
const FAIL_ORDER: readonly RegionCode[] = ["gru", "syd", "sin", "bom", "lhr"];

const DEMO_FAILURE_CODE = "TCP_TIMEOUT";

/** Dwell time per frame. Sums to ~6.5s, then the loop restarts. */
const FRAMES: readonly number[] = [1200, 800, 650, 650, 800, 2400];

const VERDICT_TONE = {
  UP: "border-up/40 bg-up/10 text-up",
  PARTIAL_OUTAGE: "border-partial/40 bg-partial/10 text-partial",
  DOWN: "border-down/40 bg-down/10 text-down",
  INCONCLUSIVE: "border-inconclusive/40 bg-inconclusive/10 text-inconclusive",
} as const;

export function ConsensusWidget() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // A frozen final frame is the accessible equivalent of the loop: it shows
    // the outcome the animation exists to explain, and nothing moves.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFrame(FRAMES.length - 1);
      return;
    }

    const timer = window.setTimeout(() => setFrame((current) => (current + 1) % FRAMES.length), FRAMES[frame]);
    return () => window.clearTimeout(timer);
  }, [frame]);

  const { rows, outcome } = useMemo(() => {
    const failing = new Set(FAIL_ORDER.slice(0, frame));
    const rows = REGIONS.map((region) => ({
      ...region,
      ok: !failing.has(region.code),
      latencyMs: DEMO_LATENCY_MS[region.code],
    }));
    return {
      rows,
      outcome: evaluateConsensus(
        rows.map((row) => ({
          regionCode: row.code,
          ok: row.ok,
          failureCode: row.ok ? null : DEMO_FAILURE_CODE,
          totalMs: row.latencyMs,
        })),
        DEFAULT_CONSENSUS,
      ),
    };
  }, [frame]);

  const failureCount = outcome.failureCount;
  const threshold = outcome.quorumThreshold;
  const total = REGIONS.length;

  const caption =
    failureCount === 0
      ? `${total} of ${total} reporting — ${threshold} failing regions would open an incident.`
      : failureCount >= threshold
        ? `${failureCount} of ${total} agree — incident opened, alerts dispatched.`
        : `${failureCount} of ${total} failing — below the ${DEFAULT_CONSENSUS.quorumRatio} quorum. No page sent.`;

  return (
    <div className="relative">
      {/*
        The animation is decorative narration of the copy beside it, so it is
        hidden from assistive tech and replaced by one static sentence. An
        aria-live region here would announce a new verdict every 650ms.
      */}
      <p className="sr-only">
        Illustration: one monitor checked from {total} regions. Sentinel keeps the monitor up while fewer
        than {threshold} regions fail, and declares it down once {threshold} or more agree — a quorum ratio
        of {DEFAULT_CONSENSUS.quorumRatio}.
      </p>

      <div
        aria-hidden
        className="overflow-hidden rounded-xl border border-line bg-surface/70 backdrop-blur-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">API — checkout</p>
            <p className="truncate font-mono text-[11px] text-ink-3">https://api.acme.com/v1/checkout</p>
          </div>
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium transition-colors duration-200",
              VERDICT_TONE[outcome.verdict],
            )}
          >
            {outcome.verdict}
          </span>
        </div>

        <ul className="divide-y divide-line/60">
          {rows.map((row) => (
            <li key={row.code} className="flex h-10 items-center gap-3 px-5 text-xs sm:gap-4">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full transition-colors duration-200",
                  row.ok ? "bg-up" : "bg-down",
                )}
              />
              <span className="w-8 shrink-0 font-mono text-ink-2">{row.code}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3">{row.city}</span>
              <span
                className={cn(
                  "tnum w-14 shrink-0 text-right font-mono transition-colors duration-200",
                  row.ok ? "text-ink-2" : "text-ink-3",
                )}
              >
                {row.ok ? `${row.latencyMs}ms` : "—"}
              </span>
              <span
                className={cn(
                  "w-24 shrink-0 text-right font-mono text-[10px] transition-colors duration-200",
                  row.ok ? "text-up/80" : "text-down",
                )}
              >
                {row.ok ? "ok" : DEMO_FAILURE_CODE}
              </span>
            </li>
          ))}
        </ul>

        {/*
          The gauge is the rule made visible: eight cells, a marker at the
          threshold. Crossing the marker is the moment an incident opens.
        */}
        <div className="space-y-2 border-t border-line px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex flex-1 gap-1">
              {rows.map((row, index) => (
                <span
                  key={row.code}
                  className={cn(
                    "relative h-1.5 flex-1 rounded-full transition-colors duration-200",
                    index < failureCount ? "bg-down" : "bg-line-strong",
                    index === threshold - 1 &&
                      "after:absolute after:-top-1 after:right-0 after:h-3.5 after:w-px after:bg-ink-3",
                  )}
                />
              ))}
            </div>
            <span className="tnum shrink-0 font-mono text-[10px] text-ink-3">
              quorum {threshold}/{total}
            </span>
          </div>
          {/* Two lines of height is reserved so the caption swap never shifts layout. */}
          <p className="flex min-h-9 items-center text-xs leading-relaxed text-ink-2">{caption}</p>
        </div>
      </div>
    </div>
  );
}
