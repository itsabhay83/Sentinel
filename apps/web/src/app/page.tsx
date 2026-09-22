import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Globe2, Radar, ShieldCheck, Waves } from "lucide-react";
import { REGIONS } from "@sentinel/shared";
import { Button, LinkButton } from "@/components/ui";
import { getSession } from "@/lib/auth";

export default async function LandingPage() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <main className="relative isolate overflow-hidden">
      {/* Ambient field: a slow radar sweep behind the fold, never in front of text. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20rem] size-[46rem] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.035)_1px,transparent_0)] [background-size:32px_32px]" />
      </div>

      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Radar className="size-5 text-accent" />
          Sentinel
        </span>
        {/*
          Clerk Core 3 removed <SignedIn>/<SignedOut> in favour of <Show when>.
          Buttons are `mode="modal"` so the marketing page never navigates away
          to sign in, and both wrap the existing Button so auth matches the rest
          of the design system rather than dropping Clerk's default styling in.
        */}
        <nav className="flex items-center gap-2">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm">
                Log in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm">Start monitoring</Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <LinkButton href="/dashboard" variant="ghost" size="sm">
              Dashboard
            </LinkButton>
            <UserButton />
          </Show>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-24">
        <div className="animate-fade-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-ink-2">
            <span className="pulse-dot relative size-1.5 rounded-full bg-accent" />
            {REGIONS.length} regions · consensus before you get paged
          </span>
          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            One region says down.
            <br />
            <span className="text-ink-2">Sentinel asks the other seven.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-ink-2">
            Most uptime tools page you the moment a single probe hiccups. Sentinel runs every check from multiple continents and only
            declares an outage when a quorum of regions agrees — so a bad transit route in São Paulo stops being your 3am problem.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <SignUpButton mode="modal">
              <Button size="lg">
                Create an account <ArrowRight className="size-4" />
              </Button>
            </SignUpButton>
            <LinkButton href="/status/acme" variant="outline" size="lg">
              See a live status page
            </LinkButton>
          </div>
          {/*
            The seeded `demo@sentinel.dev / sentinel123` pair was advertised here
            while this app hashed its own passwords. Clerk holds the credentials
            now and never saw that user, so the line would have been an
            invitation to fail at the login screen.
          */}
          <p className="mt-4 text-sm text-ink-3">Free while in beta. No card required.</p>
        </div>

        <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Globe2,
              title: "Quorum consensus",
              body: "A configurable share of regions must agree before an incident opens. Single-region noise becomes a partial outage, not a page.",
            },
            {
              icon: Waves,
              title: "Phase-level timing",
              body: "Every check records DNS, TCP, TLS, TTFB and transfer separately, so a slowdown points at a layer instead of a vibe.",
            },
            {
              icon: ShieldCheck,
              title: "SSRF-hardened probes",
              body: "Targets are resolved, validated against private ranges, and IP-pinned before a socket opens — on every redirect hop.",
            },
            {
              icon: Radar,
              title: "Region quarantine",
              body: "When one probe location goes bad, it is excluded from quorum automatically instead of corrupting everyone's verdicts.",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-line bg-surface/60 p-5 backdrop-blur">
              <f.icon className="size-5 text-accent" />
              <h3 className="mt-3 font-medium">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-3">
          {REGIONS.map((r) => (
            <span key={r.code} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-accent/60" />
              {r.city}
            </span>
          ))}
        </div>
      </section>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-ink-3">
          <span>Sentinel — multi-region uptime monitoring.</span>
          <Link href="/status/acme" className="transition-colors hover:text-ink-2">
            Public status
          </Link>
        </div>
      </footer>
    </main>
  );
}
