import Link from "next/link";
import { Radar } from "lucide-react";
import { REGIONS } from "@sentinel/shared";

/**
 * Quiet by design: `ink-3` on canvas, no accent except the logo mark and the
 * region dots, which are the one place on the page where green still has to
 * mean UP.
 */
const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Consensus", href: "#product" },
      { label: "How it works", href: "#how" },
      { label: "Prober hardening", href: "#security" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    heading: "Developers",
    links: [
      { label: "REST API", href: "#api" },
      { label: "Status pages", href: "#status" },
      // Labelled "example" because it is one: the seeded demo org's feed, not
      // Sentinel's. Unlabelled, a raw XML page of someone else's incidents is a
      // confusing place to land from a footer.
      { label: "Example RSS feed", href: "/status/acme/rss" },
    ],
  },
  {
    heading: "Company",
    links: [{ label: "Sign in", href: "/sign-in" }, { label: "Create an account", href: "/sign-up" }],
  },
  {
    heading: "Legal",
    links: [
      { label: "Data export and deletion", href: "/settings/data" },
      { label: "Security", href: "#security" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-1">
            <span className="flex items-center gap-2 font-semibold tracking-tight text-ink-2">
              <Radar className="size-4 text-accent" aria-hidden />
              Sentinel
            </span>
            <p className="mt-3 max-w-56 text-sm leading-relaxed text-ink-3">
              Multi-region uptime monitoring with consensus before the page.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-labelledby={`footer-${column.heading}`}>
              <h2 id={`footer-${column.heading}`} className="text-xs font-medium uppercase tracking-wide text-ink-2">
                {column.heading}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-ink-3 transition-colors duration-150 hover:text-ink-2"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/*
          The eight probe regions, named. The dots are emerald because that is
          what green means everywhere else on the page — but they are decoration
          here, not a live reading, so nothing claims a status this page has no
          way to know.
        */}
        <div className="mt-14 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line/60 pt-8">
          {REGIONS.map((region) => (
            <span key={region.code} className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
              <span className="size-1.5 rounded-full bg-up/70" aria-hidden />
              {region.code}
              <span className="sr-only">
                {" "}
                — {region.city}, {region.country}
              </span>
            </span>
          ))}
        </div>

        {/*
          No "System status" link here. That phrase in a footer promises *this*
          service's uptime, and the only page behind it was the seeded demo
          tenant's. Sentinel does not publish its own status page yet, so the
          honest move is to claim nothing — the same reasoning that keeps "Docs"
          out of the header nav.
        */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 text-xs text-ink-3">
          <p>© {new Date().getFullYear()} Sentinel. Multi-region uptime and synthetic monitoring.</p>
        </div>
      </div>
    </footer>
  );
}
