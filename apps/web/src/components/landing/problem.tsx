import { BellRing, CheckCircle2, ShieldQuestion } from "lucide-react";
import { DEFAULT_CONFIRMATION, DEFAULT_CONSENSUS, REGIONS } from "@sentinel/shared";

import { Reveal } from "./reveal";

/**
 * The pitch in one screen: the same failing probe, judged two ways.
 *
 * Both columns describe the identical event — one region timing out — so the
 * contrast is entirely in the decision, which is the only thing Sentinel sells.
 */
const QUORUM = Math.ceil(REGIONS.length * DEFAULT_CONSENSUS.quorumRatio);

export function ProblemSection() {
  return (
    <section aria-labelledby="problem-title" className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
      <Reveal>
        <h2
          id="problem-title"
          className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          A timeout is evidence. It is not a verdict.
        </h2>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
          One probe cannot tell &ldquo;the site is down&rdquo; apart from &ldquo;the route between one
          datacenter and the site is broken&rdquo;. Most tools never ask the difference.
        </p>
      </Reveal>

      {/* The hairline is the divider on desktop and disappears on mobile, where
          the columns stack and a vertical rule would point at nothing. */}
      <div className="mt-14 grid gap-10 md:grid-cols-2 md:gap-0 md:divide-x md:divide-line">
        <Reveal className="md:pr-10 lg:pr-14">
          <Column
            eyebrow="How most uptime tools page you"
            icon={<BellRing className="size-4" aria-hidden />}
            tone="muted"
          >
            <div className="rounded-xl border border-line bg-surface/40 p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-ink-3">03:14</span>
                <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[10px] text-ink-3">
                  DOWN
                </span>
              </div>
              <p className="mt-3 text-sm font-medium text-ink-2">API — checkout is down</p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-3">
                gru · TCP_TIMEOUT · 1 request · 1 probe
              </p>
              <div className="mt-4 space-y-1.5 border-t border-line pt-4 font-mono text-[11px] text-ink-3">
                <p>03:19 — you open a laptop</p>
                <p>03:24 — every region but São Paulo is fine</p>
                <p>03:26 — you go back to bed</p>
              </div>
            </div>
            <p className="mt-5 text-sm leading-relaxed text-ink-3">
              One probe, one failed request, one page. The transit fault was real. The outage was not.
            </p>
          </Column>
        </Reveal>

        <Reveal delayMs={120} className="md:pl-10 lg:pl-14">
          <Column
            eyebrow="How Sentinel decides"
            icon={<ShieldQuestion className="size-4" aria-hidden />}
            tone="accent"
          >
            <div className="rounded-xl border border-accent/25 bg-surface/60 p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-ink-3">03:14</span>
                <span className="rounded-full border border-partial/40 bg-partial/10 px-2 py-0.5 font-mono text-[10px] text-partial">
                  PARTIAL_OUTAGE
                </span>
              </div>
              <p className="mt-3 text-sm font-medium text-ink">API — checkout is up</p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-2">
                1 of {REGIONS.length} failing · quorum needs {QUORUM}
              </p>
              <ul className="mt-4 space-y-2 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-2">
                <Rule>
                  <code className="font-mono text-ink">F &lt; {QUORUM}</code> — recorded, charted, not
                  paged.
                </Rule>
                <Rule>
                  <code className="font-mono text-ink">gru</code> keeps failing alone — quarantined out of
                  quorum.
                </Rule>
                <Rule>
                  A flip needs {DEFAULT_CONFIRMATION.confirmationFailures} consecutive confirming cycles.
                </Rule>
              </ul>
            </div>
            <p className="mt-5 text-sm leading-relaxed text-ink-2">
              You still see it on the timeline in the morning. Your phone stays face down.
            </p>
          </Column>
        </Reveal>
      </div>
    </section>
  );
}

function Column({
  eyebrow,
  icon,
  tone,
  children,
}: {
  eyebrow: string;
  icon: React.ReactNode;
  tone: "muted" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3
        className={`flex items-center gap-2 text-sm font-medium ${
          tone === "accent" ? "text-accent" : "text-ink-3"
        }`}
      >
        {icon}
        {eyebrow}
      </h3>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
