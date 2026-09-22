"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { Submit } from "@/components/settings-forms";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { createApiKeyAction, rotateApiKeyAction } from "@/lib/actions/api-keys";
import { API_SCOPES, DEFAULT_API_SCOPES, EXPIRY_DAYS, EXPIRY_LABELS } from "@/lib/api-key-options";

function SecretAlert({ secret }: { secret: string }) {
  return (
    <Alert tone="accent">
      <span className="block text-xs">Copy this now — it will not be shown again.</span>
      <code className="mt-1.5 block break-all rounded bg-canvas/60 px-2 py-1.5 font-mono text-[11px] text-ink">{secret}</code>
    </Alert>
  );
}

export function ApiKeyForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState(createApiKeyAction, undefined);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Create an API key</CardTitle>
        <CardDescription>Shown once. Only a hash is stored, so a lost key can be rotated but never recovered.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {csrf}
          {state?.error && <Alert tone="danger">{state.error}</Alert>}
          {state?.secret && <SecretAlert secret={state.secret} />}
          <Field label="Name" htmlFor="key-name">
            <Input id="key-name" name="name" required placeholder="CI pipeline" />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm text-ink-2">Scopes</legend>
            <div className="space-y-1 rounded-lg border border-line bg-surface-2/40 p-2">
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 rounded px-2 py-1 font-mono text-xs text-ink-2 hover:bg-surface-3">
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    defaultChecked={DEFAULT_API_SCOPES.includes(scope)}
                    className="size-3.5 accent-[--color-accent]"
                  />
                  <span className="truncate">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Expiry" htmlFor="key-expiry" hint="Counted from now. An expired key is refused with 401.">
            <Select id="key-expiry" name="expiresInDays" defaultValue="0">
              {EXPIRY_DAYS.map((days) => (
                <option key={days} value={days}>
                  {EXPIRY_LABELS[days]}
                </option>
              ))}
            </Select>
          </Field>
          <Submit label="Create key" />
        </form>
      </CardContent>
    </Card>
  );
}

export function RotateKeyForm({ csrf, keyId }: { csrf: ReactNode; keyId: string }) {
  const [state, formAction] = useActionState(rotateApiKeyAction, undefined);
  const expanded = Boolean(state?.error || state?.secret);

  return (
    <form
      action={formAction}
      className={expanded ? "flex basis-full flex-wrap items-center gap-2" : "flex items-center gap-2"}
    >
      {csrf}
      <input type="hidden" name="keyId" value={keyId} />
      <Button type="submit" variant="ghost" size="sm">
        Rotate
      </Button>
      {state?.error && (
        <Alert tone="danger" className="basis-full">
          {state.error}
        </Alert>
      )}
      {state?.secret && (
        <div className="basis-full">
          <SecretAlert secret={state.secret} />
        </div>
      )}
    </form>
  );
}
