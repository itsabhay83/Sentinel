import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MONITOR_TYPES, REGIONS } from "@sentinel/shared";

import { ApiBand } from "@/components/landing/api-band";
import { HeaderAuth } from "@/components/landing/auth-buttons";
import { FeatureGrid } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { LandingHeader } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { Pipeline } from "@/components/landing/pipeline";
import { Pricing } from "@/components/landing/pricing";
import { ProblemSection } from "@/components/landing/problem";
import { SecuritySection } from "@/components/landing/security";
import { SiteFooter } from "@/components/landing/site-footer";
import { StatusTeaser } from "@/components/landing/status-teaser";
import { TrustStrip } from "@/components/landing/trust-strip";
import { getSession } from "@/lib/auth";

const TITLE = "Sentinel — quorum before you get paged";
const DESCRIPTION =
  `Multi-region uptime and synthetic monitoring. Every check runs from up to ${REGIONS.length} regions and ` +
  `an outage is only declared when a quorum of them agrees. ${MONITOR_TYPES.length} check types, ` +
  `phase-level timing, SSRF-hardened probes.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Sentinel",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

/*
 * The offers below mirror `PRICES` in `components/landing/pricing.tsx`, which
 * are placeholders pending the owner's sign-off. They are duplicated rather
 * than imported because that module is a client component and pulling it into
 * the server render to read three integers would ship the whole pricing table
 * twice. If the prices change, they change in both places.
 */
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Sentinel",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description: DESCRIPTION,
  featureList: [
    `Quorum consensus across ${REGIONS.length} probe regions`,
    "Phase-level timing waterfall (DNS, TCP, TLS, TTFB, transfer)",
    "Region quarantine",
    "SSRF-hardened, IP-pinned probing",
    "Signed webhooks (HMAC-SHA256)",
    "Public status pages with RSS and maintenance windows",
    "SLOs and error budgets",
    "REST API v1 with scoped keys",
  ],
  offers: [
    { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pro", price: "29", priceCurrency: "USD" },
    { "@type": "Offer", name: "Business", price: "99", priceCurrency: "USD" },
  ],
};

export default async function LandingPage() {
  // A signed-in visitor has no business on the pitch.
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <>
      <script
        type="application/ld+json"
        // Static object, no user input — there is nothing here to escape.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-surface-3 focus:px-4 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to content
      </a>

      <LandingHeader auth={<HeaderAuth />} />

      <main id="main">
        <Hero />
        <TrustStrip />
        <ProblemSection />
        <FeatureGrid />
        <Pipeline />
        <SecuritySection />
        <StatusTeaser />
        <Pricing />
        <ApiBand />
        <FinalCta />
      </main>

      <SiteFooter />
    </>
  );
}
