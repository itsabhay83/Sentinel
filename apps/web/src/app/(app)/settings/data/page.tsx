import type { Metadata } from "next";
import { DataExportCard, DeleteAccountCard, DeleteOrganizationCard } from "@/components/gdpr-forms";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { requireOrg } from "@/lib/auth";
import { CsrfInput } from "@/lib/csrf";
import { hasRole } from "@/lib/rbac";

export const metadata: Metadata = { title: "Data & privacy" };
export const dynamic = "force-dynamic";

export default async function DataPrivacySettings() {
  const { org, user } = await requireOrg();

  const canExport = hasRole(org.role, "admin");
  const isOwner = org.role === "owner";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-xl font-semibold text-ink">Data &amp; privacy</h1>
      <p className="mt-1 text-sm text-ink-2">
        Take your configuration and history with you, or remove it permanently.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          {canExport ? (
            <DataExportCard csrf={<CsrfInput />} slug={org.slug} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Export organization data</CardTitle>
                <CardDescription>Only an admin or owner can export an organization.</CardDescription>
              </CardHeader>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>What an export contains</CardTitle>
              <CardDescription>The shape of your account, never the credentials inside it.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm text-ink-2">
              <p>Organization, members and outstanding invitations.</p>
              <p>Monitors with their regions, assertion counts and SLO targets.</p>
              <p>Alert channels, escalation policies and maintenance windows.</p>
              <p>Status pages, API key metadata, 90 days of incidents and 90 days of audit log.</p>
              <Alert tone="warn" className="mt-3">
                Encrypted request headers and bodies, alert channel credentials, API key hashes, status page password
                hashes and session tokens are excluded by design.
              </Alert>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          {isOwner && <DeleteOrganizationCard csrf={<CsrfInput />} slug={org.slug} />}
          <DeleteAccountCard csrf={<CsrfInput />} email={user.email} />
        </div>
      </div>
    </div>
  );
}
