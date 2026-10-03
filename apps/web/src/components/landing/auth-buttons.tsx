import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";

import { Button, LinkButton } from "@/components/ui";

/**
 * Every Clerk auth affordance on the landing page, in one server module.
 *
 * `<Show>` is an async Server Component in Clerk Core 3 — it awaits `auth()` —
 * so it cannot be rendered inside a `"use client"` component. The header needs
 * client state for its scroll and menu behaviour, so the auth cluster is built
 * here and handed to it as a prop instead.
 *
 * `mode="modal"` throughout: a marketing page should never navigate away from
 * itself to collect a password. Each Clerk button wraps the design system's
 * `Button` so auth matches the rest of the page rather than inheriting Clerk's
 * default styling.
 */
export function HeaderAuth({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <Button variant="ghost" size={size}>
            Log in
          </Button>
        </SignInButton>
        <SignUpButton mode="modal">
          <Button size={size}>Start monitoring</Button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <LinkButton href="/dashboard" variant="ghost" size={size}>
          Dashboard
        </LinkButton>
        <UserButton />
      </Show>
    </>
  );
}

/**
 * The one emerald CTA per band. `label` changes, the affordance does not.
 *
 * `primary` is deliberate and rationed: the accent is reserved for a live
 * status dot, a chart stroke, and exactly one call to action per screen. The
 * header's sign-up button is the secondary fill for the same reason — two
 * emerald buttons in one viewport means neither is the primary one.
 */
export function SignUpCta({
  label,
  size = "lg",
  className,
}: {
  label: string;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <SignUpButton mode="modal">
      <Button variant="primary" size={size} className={className}>
        {label}
        <ArrowRight className="sentinel-cta-arrow" />
      </Button>
    </SignUpButton>
  );
}

/** Pricing-card CTA: same modal, no arrow, full width inside the card. */
export function SignUpPlanCta({ label, primary }: { label: string; primary: boolean }) {
  return (
    <SignUpButton mode="modal">
      <Button variant={primary ? "primary" : "outline"} className="w-full">
        {label}
      </Button>
    </SignUpButton>
  );
}
