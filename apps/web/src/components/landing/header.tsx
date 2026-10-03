"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Menu, Radar, X } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * No "Docs" entry: there is no documentation site to point at yet, and a nav
 * link that lands on a 404 costs more trust than the missing item does.
 *
 * "Status" is an on-page anchor for the same reason. In a marketing header that
 * word means *our* uptime, and Sentinel does not run a status page for itself
 * yet — pointing it at /status/acme handed visitors a seeded demo tenant and
 * let it read as either "Sentinel is operated by a company called Acme Rockets"
 * or "this vendor leaks customer pages". The teaser section it now scrolls to
 * carries the demo link in context, framed as an example.
 */
const NAV = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "API", href: "#api" },
  { label: "Status", href: "#status" },
] as const;

/**
 * Sticky marketing header.
 *
 * `auth` arrives as a prop because Clerk's `<Show>` is an async Server
 * Component and this file is a client boundary — see `auth-buttons.tsx`. The
 * same node is rendered in the desktop bar and in the mobile sheet; React is
 * happy to place one element tree in two positions.
 */
export function LandingHeader({ auth }: { auth: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Read once on mount too: a deep link or a restored scroll position lands
    // mid-page, where a transparent header would sit on top of content.
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    // The sheet covers the viewport; letting the page scroll behind it means
    // closing it can leave the visitor somewhere they never navigated to.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-200",
        scrolled ? "border-b border-line bg-canvas/80 backdrop-blur-xl" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-ink"
        >
          <Radar className="size-5 text-accent" aria-hidden />
          Sentinel
        </Link>

        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-7 text-sm text-ink-2">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="transition-colors duration-150 hover:text-ink">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">{auth}</div>
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls="landing-mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
            className="rounded-lg p-2 text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink lg:hidden"
          >
            {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>
      </div>

      {/*
        Rendered only while open rather than translated off-screen, so its links
        never sit in the tab order of the page behind it.
      */}
      {open && (
        <div
          id="landing-mobile-nav"
          className="fixed inset-0 top-16 z-40 bg-canvas/95 backdrop-blur-xl lg:hidden"
        >
          <nav aria-label="Main" className="mx-auto max-w-6xl px-6 py-8">
            <ul className="flex flex-col gap-1">
              {NAV.map((item, index) => (
                <li
                  key={item.href}
                  style={{
                    animation: "sentinel-fade-up 400ms cubic-bezier(0.22, 1, 0.36, 1) both",
                    animationDelay: `${index * 60}ms`,
                  }}
                >
                  <Link
                    href={item.href}
                    onClick={close}
                    className="block border-b border-line/60 py-4 text-lg text-ink-2 transition-colors duration-150 hover:text-ink"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-col gap-3 [&>*]:w-full [&_button]:w-full">{auth}</div>
          </nav>
        </div>
      )}
    </header>
  );
}
