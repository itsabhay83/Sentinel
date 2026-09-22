import type { Metadata } from "next";
import { Laptop } from "lucide-react";
import { MfaCard } from "@/components/mfa-forms";
import { ChangePasswordForm } from "@/components/password-forms";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { revokeAllOtherSessionsAction, revokeSessionAction } from "@/lib/actions/sessions";
import { requireSession } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { listUserSessions } from "@/lib/sessions";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

/** The user-agent string is unreadable; the product and platform are the parts a person recognises. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Firefox\/|Edg\/|Chrome\/|Safari\//.exec(userAgent)?.[0]?.replace(/[/]$/, "") ?? "Browser";
  const platform = /Windows|Macintosh|Linux|Android|iPhone|iPad/.exec(userAgent)?.[0] ?? "unknown platform";
  return `${browser === "Edg" ? "Edge" : browser} on ${platform}`;
}

export default async function SecuritySettings() {
  const session = await requireSession();
  const sessions = await listUserSessions(session.user.id);
  const others = sessions.filter((row) => row.id !== session.id);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-xl font-semibold text-ink">Security</h1>
      <p className="mt-1 text-sm text-ink-2">
        {session.user.emailVerified ? "Email verified." : "Email not verified yet."} {sessions.length} active session
        {sessions.length === 1 ? "" : "s"}.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            {others.length > 0 && (
              <form action={revokeAllOtherSessionsAction}>
                <Button type="submit" variant="ghost" size="sm">
                  Sign out everywhere else
                </Button>
              </form>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                <Laptop className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{describeDevice(row.userAgent)}</span>
                  <span className="block truncate font-mono text-xs text-ink-3">{row.ipAddress ?? "unknown ip"}</span>
                </span>
                <span className="text-xs text-ink-3">active {relativeTime(row.lastActiveAt)}</span>
                {row.id === session.id ? (
                  <Badge tone="accent">this device</Badge>
                ) : (
                  <form action={revokeSessionAction.bind(null, row.id)}>
                    <Button type="submit" variant="ghost" size="sm">
                      Revoke
                    </Button>
                  </form>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <MfaCard csrf={<CsrfInput />} enabled={session.user.mfaEnabled} />
          <ChangePasswordForm csrf={<CsrfInput />} />
        </div>
      </div>
    </div>
  );
}
