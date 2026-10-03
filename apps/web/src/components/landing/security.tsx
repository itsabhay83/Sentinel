import { ShieldCheck } from "lucide-react";

import { Reveal } from "./reveal";

/**
 * The band that exists because the product's central feature is also its
 * central liability: a service that fetches arbitrary URLs on demand is an SSRF
 * proxy unless every one of these guards holds.
 *
 * Each line is a mechanism that is actually implemented — the CIDR count is the
 * length of `BLOCKED_RANGES` in `@sentinel/checker`.
 */
const GUARDS: readonly string[] = [
  "Every resolved address is matched against 17 blocked CIDR ranges — all RFC1918 space, loopback, carrier-grade NAT, multicast, and 169.254.0.0/16 cloud metadata.",
  "IPv4-mapped IPv6 is unwrapped before matching, so ::ffff:169.254.169.254 cannot smuggle a link-local address past a v6 check.",
  "The validated IP is pinned into the connection. DNS rebinding has nothing left to redirect — the socket already knows where it is going.",
  "Every redirect hop is re-validated. A public URL that 302s to 127.0.0.1 gets stopped on the second hop, not the first.",
  "ICMP shells out with an argv array against the resolved IP, never the hostname a user typed. There is no shell to inject into.",
];

const TERMINAL: readonly { ok: boolean; target: string; note: string }[] = [
  { ok: false, target: "http://169.254.169.254/latest/meta-data", note: "blocked · link-local" },
  { ok: false, target: "http://localhost:5432", note: "blocked · loopback" },
  { ok: true, target: "https://api.acme.com", note: "93.184.216.34 pinned" },
];

export function SecuritySection() {
  return (
    <section id="security" aria-labelledby="security-title" className="border-y border-line/60 bg-surface-2/40">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <div className="grid gap-14 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-ink-2">
              <ShieldCheck className="size-3.5 text-accent" aria-hidden />
              Prober hardening
            </span>
            <h2
              id="security-title"
              className="mt-6 text-balance text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              The prober is a deliberate SSRF machine.
            </h2>
            <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
              It fetches URLs strangers type in, from inside your infrastructure. That is the definition of
              server-side request forgery, so it is guarded like one rather than hoped about.
            </p>

            <ul className="mt-10 space-y-5">
              {GUARDS.map((guard, index) => (
                <li key={guard} className="flex gap-3.5">
                  <svg
                    viewBox="0 0 24 24"
                    className="mt-0.5 size-4 shrink-0"
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {/* Staggered so the five checks read as a sequence being run,
                        not five facts arriving at once. */}
                    <path
                      data-draw
                      d="M20 6 9 17l-5-5"
                      pathLength={100}
                      style={{ animationDelay: `${index * 140}ms` }}
                    />
                  </svg>
                  <p className="text-sm leading-relaxed text-ink-2">{guard}</p>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delayMs={120} className="lg:pt-16">
            <div className="overflow-hidden rounded-xl border border-line bg-canvas/80 backdrop-blur">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
                <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
                <span className="size-2.5 rounded-full bg-line-strong" aria-hidden />
                <span className="ml-2 font-mono text-[11px] text-ink-3">checker.test.ts</span>
              </div>
              <div className="overflow-x-auto p-4">
                <table className="w-full font-mono text-[11px] leading-loose">
                  <caption className="sr-only">
                    Probe targets and the verdict the SSRF guard returns for each.
                  </caption>
                  <tbody>
                    {TERMINAL.map((row) => (
                      <tr key={row.target}>
                        <td className={`pr-3 align-top ${row.ok ? "text-up" : "text-down"}`}>
                          {row.ok ? "✓" : "✗"}
                        </td>
                        <td className="whitespace-nowrap pr-8 align-top text-ink-2">{row.target}</td>
                        <td className={`whitespace-nowrap align-top ${row.ok ? "text-ink-3" : "text-down/80"}`}>
                          {row.note}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-4 font-mono text-[11px] leading-relaxed text-ink-3">
              timing.tcpMs === null — rejected before any socket opened.
            </p>

            <div className="mt-8 rounded-xl border border-line bg-surface/40 p-5">
              <h3 className="text-sm font-medium tracking-tight text-ink">Encryption at rest</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">
                Monitor headers, request bodies and webhook secrets are AES-256-GCM encrypted. They
                routinely carry bearer tokens, and a job queue writes everything it holds to an
                append-only file — so credentials never sit in it readable.
              </p>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-ink-3">
                Outbound webhooks are signed HMAC-SHA256 over ${"{timestamp}"}.${"{body}"} in
                X-Sentinel-Signature, with a 300-second replay window.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
