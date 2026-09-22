"use client";

import type { ReactNode } from "react";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Download } from "lucide-react";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { deleteAccountAction, deleteOrganizationAction, exportOrganizationDataAction } from "@/lib/actions/gdpr";

function Submit({ label, variant }: { label: string; variant: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

export function DataExportCard({ csrf, slug }: { csrf: ReactNode; slug: string }) {
  const [state, formAction] = useActionState(exportOrganizationDataAction, undefined);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const payload = state?.secret;

  // The JSON only ever exists in this response, so it is handed to the browser
  // as an object URL rather than re-fetched from a route that would have to
  // re-authorise it.
  useEffect(() => {
    if (payload === undefined) {
      setDownloadUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    setDownloadUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [payload]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export organization data</CardTitle>
        <CardDescription>
          Monitors, alerting, status pages, incidents and the audit trail as JSON. Encrypted credentials, key hashes and
          password hashes are never included.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          <Submit label="Generate export" variant="primary" />
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={`sentinel-${slug}-export.json`}
              className="inline-flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent transition-colors hover:bg-accent/20"
            >
              <Download className="size-4" />
              Download sentinel-{slug}-export.json
            </a>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function DangerCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="border-down/30">
      <CardHeader>
        <CardTitle className="text-down">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function DeleteOrganizationCard({ csrf, slug }: { csrf: ReactNode; slug: string }) {
  const [state, formAction] = useActionState(deleteOrganizationAction, undefined);

  return (
    <DangerCard
      title="Delete this organization"
      description="Monitors, history, incidents, status pages and every teammate's access are removed. This cannot be undone."
    >
      <form action={formAction} className="space-y-3">
        {csrf}
        {state?.error && <Alert tone="danger">{state.error}</Alert>}
        <Field label={`Type ${slug} to confirm`} htmlFor="delete-org-confirm">
          <Input id="delete-org-confirm" name="confirm" autoComplete="off" placeholder={slug} required />
        </Field>
        <Submit label="Delete organization" variant="danger" />
      </form>
    </DangerCard>
  );
}

export function DeleteAccountCard({ csrf, email }: { csrf: ReactNode; email: string }) {
  const [state, formAction] = useActionState(deleteAccountAction, undefined);

  return (
    <DangerCard
      title="Delete your account"
      description="Removes your sign-in, sessions, two-factor enrolment and any organization where you are the only member."
    >
      <form action={formAction} className="space-y-3">
        {csrf}
        {state?.error && <Alert tone="danger">{state.error}</Alert>}
        <Field label="Type your email address to confirm" htmlFor="delete-account-confirm">
          <Input id="delete-account-confirm" name="confirm" autoComplete="off" placeholder={email} required />
        </Field>
        <Submit label="Delete account" variant="danger" />
      </form>
    </DangerCard>
  );
}
