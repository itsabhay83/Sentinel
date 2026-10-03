"use client";

import { useEffect, useState } from "react";
import { MONITOR_TYPES, PLAN_LIMITS, REGIONS, ROLLUP_RETENTION_MONTHS } from "@sentinel/shared";

import { useCountUp } from "./use-count-up";
import { useReveal } from "./use-reveal";

/**
 * Facts, not logos.
 *
 * A marketing page has nothing to prove with a wall of customer marks it has
 * not earned, so this strip counts up the five numbers the rest of the page
 * then goes on to justify. Every one of them is read from the shared package
 * except the test count, which no module exports.
 */
const TEST_COUNT = 983; // `pnpm test` — shared 555, scheduler 300, checker 68, db 60.

const STATS = [
  { value: REGIONS.length, suffix: "", label: "probe regions" },
  { value: MONITOR_TYPES.length, suffix: "", label: "check types" },
  { value: PLAN_LIMITS.business.minIntervalSeconds, suffix: "s", label: "minimum interval" },
  { value: ROLLUP_RETENTION_MONTHS, suffix: " mo", label: "rollup retention" },
  { value: TEST_COUNT, suffix: "", label: "tests in CI" },
] as const;

export function TrustStrip() {
  // One observer for the whole row rather than five: the numbers are meant to
  // tick together, and five observers on one strip is four too many.
  const { ref, revealed } = useReveal<HTMLDivElement>();

  /*
   * The server renders the finished numbers, which is what a visitor without
   * scripting has to keep. Zeroing them is therefore a client-only act, done
   * after mount so the hydrated tree still matches the HTML that arrived. The
   * strip sits below the fold, so the swap to 0 is never on screen.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);

  return (
    <div ref={ref} className="border-y border-line/60">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-x-6 gap-y-8 px-6 py-10 sm:grid-cols-3 lg:grid-cols-5">
        {STATS.map((stat) => (
          <Stat key={stat.label} {...stat} run={armed && revealed} armed={armed} />
        ))}
      </dl>
    </div>
  );
}

function Stat({
  value,
  suffix,
  label,
  run,
  armed,
}: {
  value: number;
  suffix: string;
  label: string;
  run: boolean;
  armed: boolean;
}) {
  const counted = useCountUp(value, run);

  return (
    <div>
      <dd className="tnum text-3xl font-semibold tracking-tight text-ink">
        {/* The real figure is always in the accessibility tree, so a screen
            reader never hears a number mid-tween. */}
        <span className="sr-only">
          {value}
          {suffix}
        </span>
        <span aria-hidden>
          {armed ? counted : value}
          {suffix}
        </span>
      </dd>
      <dt className="mt-1 text-sm text-ink-2">{label}</dt>
    </div>
  );
}
