import { REGIONS } from "@sentinel/shared";

import { LinkButton } from "@/components/ui";
import { SignUpCta } from "./auth-buttons";
import { ConsensusWidget } from "./consensus-widget";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      {/*
        Ambient field. Both layers sit on a negative z-index inside an isolated
        stacking context, so they can never paint over text or intercept a click
        no matter how the sections below are ordered.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="sentinel-dotgrid absolute inset-0" />
        <div className="absolute left-1/2 top-[-26rem] size-[52rem] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-[140px]" />
        <div className="sentinel-radar absolute left-1/2 top-[-30rem] size-[60rem] -translate-x-1/2 rounded-full" />
      </div>

      <div className="mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-24 lg:pb-32">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-ink-2 backdrop-blur">
            <span className="pulse-dot relative size-1.5 rounded-full bg-accent text-accent" />
            {/* One flex item, not three: `gap-2` applies between every child, so a
                separate <span> for the number would sit two gaps from the word. */}
            <span>
              <span className="tnum">{REGIONS.length}</span> regions · consensus before you get paged
            </span>
          </span>

          <h1
            id="hero-title"
            className="mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl"
          >
            One region says down.
            <br />
            <span className="text-ink-2">Sentinel asks the other seven.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-ink-2">
            Most uptime tools page you the moment a single probe hiccups. Sentinel runs every check from up to{" "}
            {REGIONS.length} independent regions and only declares an outage when a quorum of regions agrees. A
            bad transit route in São Paulo stops being a 3am problem.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <SignUpCta label="Start monitoring free" />
            <LinkButton href="/status/acme" variant="outline" size="lg">
              See a live status page
            </LinkButton>
          </div>

          <p className="mt-4 text-sm text-ink-3">Free while in beta. No card required.</p>
        </div>

        <div className="mt-16 lg:mt-20">
          <ConsensusWidget />
        </div>
      </div>
    </section>
  );
}
