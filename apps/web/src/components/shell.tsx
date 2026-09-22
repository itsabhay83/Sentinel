"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ChevronDown, DatabaseZap, Gauge, Globe2, KeyRound, LayoutGrid, LogOut, Menu, Radar, ScrollText, Settings, ShieldCheck, Siren, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Monitors", icon: LayoutGrid },
  { href: "/incidents", label: "Incidents", icon: Siren },
  { href: "/slos", label: "SLOs", icon: Gauge },
  { href: "/regions", label: "Regions", icon: Globe2 },
  { href: "/settings/alerts", label: "Alerting", icon: AlertTriangle },
  { href: "/settings/status-pages", label: "Status pages", icon: Settings },
  { href: "/settings/api", label: "API keys", icon: KeyRound },
  { href: "/settings/team", label: "Team", icon: Users },
  { href: "/settings/security", label: "Security", icon: ShieldCheck },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText },
  { href: "/settings/data", label: "Data & privacy", icon: DatabaseZap },
] as const;

export function Sidebar({
  org,
  user,
  openIncidents,
  logout,
}: {
  org: { name: string; slug: string; plan: string };
  user: { name: string; email: string };
  openIncidents: number;
  logout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 p-3">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === "/dashboard" && pathname.startsWith("/monitors"));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              active ? "bg-surface-3 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <item.icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-ink-3 group-hover:text-ink-2")} />
            <span className="flex-1">{item.label}</span>
            {item.href === "/incidents" && openIncidents > 0 && (
              <span className="tnum rounded-full bg-down/15 px-1.5 py-0.5 text-[10px] font-medium text-down">{openIncidents}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="border-t border-line p-3">
      <div className="rounded-lg px-3 py-2">
        <p className="truncate text-sm text-ink">{user.name || user.email}</p>
        <p className="truncate text-xs text-ink-3">{user.email}</p>
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <LogOut className="size-4 text-ink-3" />
          Sign out
        </button>
      </form>
    </div>
  );

  const header = (
    <div className="flex items-center justify-between border-b border-line p-4">
      <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
        <Radar className="size-5 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-tight">{org.name}</span>
          <span className="block truncate text-[11px] capitalize leading-tight text-ink-3">{org.plan} plan</span>
        </span>
      </Link>
      <button type="button" className="text-ink-3 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
        <X className="size-5" />
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile trigger lives in the flow so it never overlaps page content. */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="sticky top-0 z-30 flex w-full items-center gap-2 border-b border-line bg-canvas/90 px-4 py-3 text-sm text-ink-2 backdrop-blur lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
        <Radar className="size-4 text-accent" />
        <span className="font-medium text-ink">{org.name}</span>
        <ChevronDown className="ml-auto size-4" />
      </button>

      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/40 lg:flex">
        {header}
        {nav}
        {footer}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-canvas/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)} aria-label="Close" />
          <div className="relative flex h-full w-72 flex-col border-r border-line bg-surface">
            {header}
            {nav}
            {footer}
          </div>
        </div>
      )}
    </>
  );
}
