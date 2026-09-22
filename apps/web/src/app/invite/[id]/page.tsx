import type { Metadata } from "next";
import { UserPlus } from "lucide-react";
import { sql as rawSql } from "@sentinel/db";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { acceptInvitationAction } from "@/lib/actions/team";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Join a workspace", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

export default async function InvitePage({ params, searchParams }: Props) {
  const [{ id }, { error }, session] = await Promise.all([params, searchParams, getSession()]);

  const [invite] = await rawSql<{ email: string; role: string; org_name: string; inviter: string }[]>`
    SELECT i.email, i.role, o.name AS org_name, u.name AS inviter
    FROM invitations i
    JOIN organizations o ON o.id = i.organization_id
    JOIN users u ON u.id = i.inviter_id
    WHERE i.id = ${id} AND i.status = 'pending' AND i.expires_at > now()
  `;

  // The invited address is the only thing that can redeem the link, so an
  // account signed in as somebody else has to be told to switch rather than
  // being handed a button that will bounce them back here.
  const mismatch = session !== null && invite !== undefined && session.user.email.toLowerCase() !== invite.email;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <UserPlus className="size-5 text-accent" />
          <CardTitle>{invite ? `Join ${invite.org_name}` : "Invitation unavailable"}</CardTitle>
          <CardDescription>
            {invite
              ? `${invite.inviter} invited ${invite.email} to join as ${invite.role}.`
              : "This invitation has been used, revoked, or has expired. Ask for a new one."}
          </CardDescription>
        </CardHeader>
        {invite && (
          <CardContent className="space-y-4">
            {error === "invalid" && <Alert tone="danger">That invitation could not be accepted. It may have expired or been sent to a different address.</Alert>}
            {mismatch ? (
              <Alert tone="warn">
                You are signed in as {session?.user.email}. Sign out and sign back in as {invite.email} to accept.
              </Alert>
            ) : (
              <form action={acceptInvitationAction.bind(null, id)}>
                <Button type="submit" variant="primary" className="w-full">
                  {session ? "Accept invitation" : "Sign in to accept"}
                </Button>
              </form>
            )}
          </CardContent>
        )}
      </Card>
    </main>
  );
}
