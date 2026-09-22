"use client";

import type { ReactNode } from "react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Copy } from "lucide-react";
import { changeMemberRoleAction, inviteMemberAction } from "@/lib/actions/team";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";

function Submit({ label, full = true }: { label: string; full?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size={full ? "md" : "sm"} className={full ? "w-full" : undefined} disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

/**
 * Shown when the invite email could not be sent (no RESEND_API_KEY). The link is
 * the only copy of the token, so it has to be recoverable from the screen.
 */
function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-line-strong bg-surface-2 p-3">
      <p className="text-xs text-ink-2">Email delivery is not configured. Send this link yourself:</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface-3 px-2 py-1.5 text-[11px] text-ink">{link}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function InviteForm({ csrf, roles }: { csrf: ReactNode; roles: string[] }) {
  const [state, formAction] = useActionState(inviteMemberAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a teammate</CardTitle>
        <CardDescription>They join this workspace when they accept. The link expires in 7 days.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && !state.secret && <Alert tone="accent">Invitation sent.</Alert>}
          {state?.secret && <InviteLink link={state.secret} />}
          <Field label="Email">
            <Input name="email" type="email" placeholder="teammate@company.com" required />
          </Field>
          <Field label="Role" hint="Admins manage the team, channels, and status pages. Viewers cannot change anything.">
            <Select name="role" defaultValue="member">
              {roles
                .filter((r) => r !== "owner")
                .map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
            </Select>
          </Field>
          <Submit label="Send invitation" />
        </form>
      </CardContent>
    </Card>
  );
}

export function MemberRoleForm({ csrf, memberId, role, roles }: { csrf: ReactNode; memberId: string; role: string; roles: string[] }) {
  const [state, formAction] = useActionState(changeMemberRoleAction, undefined);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      {csrf}
      <input type="hidden" name="memberId" value={memberId} />
      <Select name="role" defaultValue={role} className="h-8 w-28 text-xs">
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </Select>
      <Submit label="Save" full={false} />
      {state?.error && (
        <Alert tone="danger" className="basis-full">
          {state.error}
        </Alert>
      )}
    </form>
  );
}
