"use client";

/*
 * ⚠ The dollar amounts in `PRICES` are PLACEHOLDERS and need the owner's sign-off
 * before this page ships. Nothing in the repository integrates Stripe, so there
 * is no billing system for them to be wrong against yet.
 *
 * Every *limit* below, by contrast, is real: it is read straight out of
 * `PLAN_LIMITS` in `@sentinel/shared`, which is the seam the application already
 * enforces against. If a number on this page disagrees with what a customer hits
 * in the product, the bug is here, not there — do not hardcode a limit.
 */

import { useId, useState } from "react";
import { Check, Minus } from "lucide-react";
import { SignUpButton } from "@clerk/nextjs";
import { PLAN_LIMITS, PLANS, REGIONS, ROLLUP_RETENTION_MONTHS, type Plan } from "@sentinel/shared";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";

const PRICES: Record<Plan, number> = { free: 0, pro: 29, business: 99 };

/** Annual billing bills ten months and gives twelve. */
const ANNUAL_MONTHS = 10;

const PLAN_COPY: Record<Plan, { name: string; tagline: string; cta: string }> = {
  free: {
    name: "Free",
    tagline: "Enough to protect a side project properly, not a crippled trial.",
    cta: "Start monitoring free",
  },
  pro: {
    name: "Pro",
    tagline: "Every region, a 60-second floor, and a month of raw checks to dig through.",
    cta: "Start monitoring free",
  },
  business: {
    name: "Business",
    tagline: "A 30-second floor and the headroom to put every service behind it.",
    cta: "Talk to us",
  },
};

/**
 * Sub-minute floors are the thing a paid tier is actually buying, so they stay
 * in seconds. Rendering the Pro floor as "1 min" would make it look identical
 * to a five-minute plan at a glance.
 */
function intervalLabel(seconds: number): string {
  return seconds >= 300 ? `${seconds / 60} min` : `${seconds} sec`;
}

/** Each row reads one field off `PLAN_LIMITS`, so the card cannot drift from the product. */
const LIMIT_ROWS: readonly { label: string; value: (plan: Plan) => string; emphasise?: (plan: Plan) => boolean }[] = [
  { label: "Monitors", value: (p) => PLAN_LIMITS[p].maxMonitors.toLocaleString("en-US") },
  {
    label: "Minimum interval",
    value: (p) => intervalLabel(PLAN_LIMITS[p].minIntervalSeconds),
    emphasise: (p) => PLAN_LIMITS[p].minIntervalSeconds === 30,
  },
  {
    label: "Regions per monitor",
    value: (p) =>
      PLAN_LIMITS[p].maxRegionsPerMonitor >= REGIONS.length
        ? `All ${REGIONS.length}`
        : String(PLAN_LIMITS[p].maxRegionsPerMonitor),
    emphasise: (p) => PLAN_LIMITS[p].maxRegionsPerMonitor >= REGIONS.length,
  },
  { label: "Raw check retention", value: (p) => `${PLAN_LIMITS[p].rawRetentionDays} days` },
  { label: "Status pages", value: (p) => String(PLAN_LIMITS[p].maxStatusPages) },
  { label: "Alert channels", value: (p) => String(PLAN_LIMITS[p].maxAlertChannels) },
  { label: "Team members", value: (p) => String(PLAN_LIMITS[p].maxTeamMembers) },
  { label: "Monitor creations / hour", value: (p) => String(PLAN_LIMITS[p].monitorCreationsPerHour) },
];

/** Listed once, below the cards — repeating nine lines three times says nothing. */
const EVERY_PLAN: readonly string[] = [
  "Quorum consensus across every enabled region",
  "All six check types — HTTP, TCP, ICMP, DNS, heartbeat, flow",
  "Phase-level timing on every check",
  "SSRF-hardened, IP-pinned probes",
  "Signed webhooks — HMAC-SHA256, 300s replay window",
  "REST API v1 with scoped keys",
  "SLOs and error budgets",
  "Audit log and role-based access",
  `${ROLLUP_RETENTION_MONTHS}-month rollup retention`,
];

const FAQ: readonly { q: string; a: string }[] = [
  {
    q: "What counts as a monitor?",
    a: "One target on one schedule. A monitor checked from all eight regions is still one monitor — regions are not billed separately, because charging per region would penalise exactly the behaviour that makes the verdict trustworthy.",
  },
  {
    q: "What happens when I hit a limit?",
    a: "Creation is refused with a clear error; nothing already running is touched. Monitor creation is additionally rate-limited per hour, which is a separate guard against a runaway script rather than a second quota.",
  },
  {
    q: "Do failed regions count against my quota?",
    a: "No. The quota is regions per monitor, counted as the regions you enable. A region that is failing — or that has been quarantined out of quorum — still belongs to the monitor and does not free up a slot.",
  },
  {
    q: "Can I self-host?",
    a: "The whole system is a Docker Compose stack: Postgres, Redis, a leader-locked scheduler, and one probe process per region. Running it yourself means running probes in eight places, which is the part that is genuinely hard to replicate.",
  },
  {
    q: "What happens to my data at the end of retention?",
    a: `Raw check rows live in monthly partitions that are dropped whole once they pass your plan's retention. The 5-minute and 1-hour rollups they fed are kept for ${ROLLUP_RETENTION_MONTHS} months on every plan, so a 90-day uptime chart keeps working long after the rows behind it are gone.`,
  },
];

export function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
      <Reveal>
        <h2
          id="pricing-title"
          className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          Pricing that scales with monitors, not with regions
        </h2>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
          Every plan gets the consensus engine. The paid tiers buy you more monitors, a lower interval
          floor, and longer raw retention.
        </p>
      </Reveal>

      <Reveal className="mt-10" delayMs={60}>
        <BillingToggle annual={annual} onChange={setAnnual} />
      </Reveal>

      <div className="mt-10 grid gap-5 lg:grid-cols-3">
        {PLANS.map((plan, index) => (
          <Reveal key={plan} delayMs={index * 70}>
            <PlanCard plan={plan} annual={annual} />
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-12" delayMs={80}>
        <div className="rounded-xl border border-line bg-surface/40 p-6 backdrop-blur">
          <h3 className="text-sm font-medium tracking-tight text-ink">On every plan, including Free</h3>
          <ul className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {EVERY_PLAN.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
                <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Reveal>

      <Reveal className="mt-16" delayMs={80}>
        <h3 className="text-xl font-semibold tracking-tight">Before you ask</h3>
        <dl className="mt-6 max-w-2xl divide-y divide-line border-y border-line">
          {FAQ.map((item) => (
            <FaqItem key={item.q} question={item.q} answer={item.a} />
          ))}
        </dl>
      </Reveal>
    </section>
  );
}

function BillingToggle({ annual, onChange }: { annual: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/*
        A switch, not two buttons: there are exactly two states and one of them
        is the default, which is what `role="switch"` describes. The labels stay
        outside it so a pointer has something forgiving to aim at.
      */}
      <span className={cn("text-sm", annual ? "text-ink-3" : "text-ink")}>Monthly</span>
      <button
        type="button"
        role="switch"
        aria-checked={annual}
        aria-label="Bill annually"
        onClick={() => onChange(!annual)}
        className="relative h-6 w-11 shrink-0 rounded-full border border-line-strong bg-surface-2 transition-colors duration-200 hover:border-accent/50"
      >
        <span
          aria-hidden
          className={cn(
            "sentinel-knob absolute left-0.5 top-1/2 size-4 -translate-y-1/2 rounded-full transition-colors",
            annual ? "translate-x-5 bg-accent" : "translate-x-0 bg-ink-3",
          )}
        />
      </button>
      <span className={cn("text-sm", annual ? "text-ink" : "text-ink-3")}>Annual</span>
      <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
        2 months free
      </span>
    </div>
  );
}

function PlanCard({ plan, annual }: { plan: Plan; annual: boolean }) {
  const copy = PLAN_COPY[plan];
  const featured = plan === "pro";
  const monthly = PRICES[plan];
  const amount = annual ? monthly * ANNUAL_MONTHS : monthly;

  return (
    <div
      className={cn(
        "sentinel-card relative flex h-full flex-col overflow-hidden rounded-xl border p-6 backdrop-blur",
        featured
          ? "border-accent/40 bg-surface/80 shadow-[0_0_40px_-16px_rgba(16,185,129,0.45)]"
          : "border-line bg-surface/50",
      )}
    >
      {featured && (
        <>
          {/* One pass, on entrance. An infinite sheen next to a price is a casino. */}
          <span
            aria-hidden
            className="sentinel-shimmer pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-accent/[0.08] to-transparent"
          />
          <span className="absolute right-6 top-6 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            Most popular
          </span>
        </>
      )}

      <h3 className="text-base font-medium tracking-tight text-ink">{copy.name}</h3>

      <p className="mt-5 flex items-baseline gap-1.5">
        {/*
          Keyed on the rendered amount so React replaces the node when the toggle
          flips, which replays the entrance animation. A tween between arbitrary
          integers would land on values nobody is ever charged.
        */}
        <span
          key={amount}
          className="tnum text-4xl font-semibold tracking-tight text-ink"
          style={{ animation: "sentinel-fade-up 220ms cubic-bezier(0.22, 1, 0.36, 1) both" }}
        >
          ${amount}
        </span>
        <span className="text-sm text-ink-3">{monthly === 0 ? "forever" : annual ? "/year" : "/month"}</span>
      </p>
      {/* Reserved whether or not it has text, so toggling never shifts the card. */}
      <p className="mt-1 min-h-4 text-[11px] text-ink-3">
        {monthly > 0 && annual ? `Billed as ${ANNUAL_MONTHS} months — 2 free.` : " "}
      </p>

      <p className="mt-4 text-sm leading-relaxed text-ink-2">{copy.tagline}</p>

      <dl className="mt-6 space-y-2.5 border-t border-line pt-6 text-sm">
        {LIMIT_ROWS.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-ink-3">{row.label}</dt>
            <dd
              className={cn(
                "tnum shrink-0 font-mono text-[13px]",
                row.emphasise?.(plan) ? "text-accent" : "text-ink-2",
              )}
            >
              {row.value(plan)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 pt-2">
        <SignUpButton mode="modal">
          <Button variant={featured ? "primary" : "outline"} className="w-full">
            {copy.cta}
          </Button>
        </SignUpButton>
      </div>
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div>
      <dt>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-6 py-4 text-left text-sm font-medium text-ink transition-colors duration-150 hover:text-accent"
        >
          {question}
          {/*
            Two crossed strokes rotated into a plus or a minus. One element that
            rotates beats swapping two icons, which would restart the transition.
          */}
          <span className="relative size-4 shrink-0 text-ink-3" aria-hidden>
            <Minus className="absolute inset-0 size-4" />
            <Minus
              className={cn(
                "absolute inset-0 size-4 transition-transform duration-200 ease-out",
                open ? "rotate-0" : "rotate-90",
              )}
            />
          </span>
        </button>
      </dt>
      {/*
        `grid-template-rows: 0fr → 1fr` animates to the content's own height, so
        nothing has to guess a max-height that would clip at 390px.
      */}
      <dd id={id} className="sentinel-disclosure" data-open={open}>
        <div>
          <p className="max-w-2xl pb-5 pr-6 text-sm leading-relaxed text-ink-2">{answer}</p>
        </div>
      </dd>
    </div>
  );
}
