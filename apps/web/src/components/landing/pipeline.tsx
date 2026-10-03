import type { ReactNode } from "react";
import { DEFAULT_CONFIRMATION, DEFAULT_CONSENSUS } from "@sentinel/shared";

import { Reveal } from "./reveal";

/**
 * One check, end to end.
 *
 * The connecting line draws itself and each node lights as the line reaches it,
 * which is the only reason the stagger below is computed against the line's
 * travel rather than the page's usual 60ms sibling stagger — a node lighting
 * before the line arrives would break the causal story the section is telling.
 */
const LINE_DURATION_MS = 900;

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-ink-2">{children}</code>;
}

const STEPS: readonly { title: string; body: ReactNode; detail: ReactNode }[] = [
  {
    title: "Scheduler claims",
    body: (
      <>
        A leader-locked scheduler claims every due monitor with one{" "}
        <Mono>FOR UPDATE SKIP LOCKED</Mono> statement that also advances its next run.
      </>
    ),
    detail: "Two schedulers never double-dispatch — the claim and the reschedule are one write.",
  },
  {
    title: "Fan out",
    body: (
      <>
        One job per enabled region lands on <Mono>checks-&lt;region&gt;</Mono> in Redis.
      </>
    ),
    detail: "Headers and bodies travel AES-256-GCM encrypted; BullMQ persists every job to disk.",
  },
  {
    title: "Probe runs",
    body: (
      <>
        The regional worker resolves the host, validates the address, pins the IP into the connection, and
        runs the check.
      </>
    ),
    detail: "The full DNS → TCP → TLS → TTFB → transfer breakdown lands in the partitioned checks table.",
  },
  {
    title: "Consensus",
    body: (
      <>
        Once every region reports — or a 20-second grace window lapses — the evaluator applies the quorum
        rule.
      </>
    ),
    detail: `F >= ceil(N × ${DEFAULT_CONSENSUS.quorumRatio}) is DOWN, damped through ${DEFAULT_CONFIRMATION.confirmationFailures} confirming cycles.`,
  },
  {
    title: "Alert",
    body: <>Deliveries are queued inside the same transaction that opens the incident.</>,
    detail: "ON CONFLICT DO NOTHING against a unique index — one alert per incident per channel.",
  },
];

export function Pipeline() {
  return (
    <section id="how" aria-labelledby="pipeline-title" className="border-y border-line/60 bg-surface/20">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <Reveal>
          <h2
            id="pipeline-title"
            className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            How a check happens
          </h2>
          <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
            Five steps between a due monitor and a page. Each one is a named mechanism you can reason about
            at 3am.
          </p>
        </Reveal>

        <Reveal className="mt-16">
          <div className="relative">
            {/*
              The line is drawn twice rather than reflowed: an SVG path cannot
              change orientation, and `preserveAspectRatio="none"` lets each copy
              stretch to whatever the breakpoint hands it. Both are absolutely
              positioned over reserved space, so neither can shift the nodes.
            */}
            <svg
              aria-hidden
              className="pointer-events-none absolute left-0 top-3 hidden h-px w-full lg:block"
              viewBox="0 0 1000 1"
              preserveAspectRatio="none"
            >
              <path
                data-draw
                d="M100 0.5 L900 0.5"
                pathLength={100}
                stroke="var(--color-accent)"
                strokeWidth="1"
                fill="none"
                opacity="0.45"
              />
            </svg>

            <svg
              aria-hidden
              className="pointer-events-none absolute left-[11px] top-0 h-full w-px lg:hidden"
              viewBox="0 0 1 1000"
              preserveAspectRatio="none"
            >
              <path
                data-draw
                d="M0.5 24 L0.5 940"
                pathLength={100}
                stroke="var(--color-accent)"
                strokeWidth="1"
                fill="none"
                opacity="0.45"
              />
            </svg>

            <ol className="relative grid gap-10 lg:grid-cols-5 lg:gap-6">
              {STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className="sentinel-node group relative pl-10 lg:pl-0 lg:text-center"
                  style={{ animationDelay: `${Math.round((index / (STEPS.length - 1)) * LINE_DURATION_MS)}ms` }}
                >
                  <span
                    className="tnum absolute left-0 top-0 flex size-6 items-center justify-center rounded-full border border-accent/50 bg-canvas font-mono text-[11px] text-accent lg:static lg:mx-auto"
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <h3 className="text-sm font-medium tracking-tight text-ink lg:mt-4">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">{step.body}</p>
                  {/*
                    Dimmed rather than hidden, and in normal flow. A tooltip that
                    only appears on hover would be unreachable on a touch screen,
                    which is where most of this section's traffic will read it.
                  */}
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-3 opacity-60 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                    {step.detail}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
