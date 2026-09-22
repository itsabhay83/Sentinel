import "server-only";

import { sql as rawSql } from "@sentinel/db";
import { getServerEnv } from "@sentinel/shared/env";
import { hashApiKey } from "@sentinel/shared/server";

import type { ApiScope } from "./api-key-options";

export type ApiCaller = { organizationId: string; keyId: string; scopes: string[] };

/** A key touched inside this window does not get another `last_used_at` write. */
const LAST_USED_THROTTLE_SECONDS = 60;

/**
 * Authenticates a public REST request.
 *
 * The presented key is hashed and matched against the stored hash — the plaintext
 * key exists only in the caller's environment, so a database leak cannot be
 * replayed against the API.
 *
 * Liveness (revoked, expired) and the `last_used_at` throttle are both evaluated
 * in Postgres against `now()`: comparing timestamps in JavaScript would depend on
 * the web process's clock and on whether the driver handed back a Date or a string.
 */
export async function authenticateApiKey(request: Request): Promise<ApiCaller | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const key = header.slice(7).trim();
  if (!key.startsWith("sk_live_")) return null;

  const rows = await rawSql<
    {
      id: string;
      organization_id: string;
      scopes: string[] | null;
      inactive: boolean;
      last_used_is_stale: boolean;
    }[]
  >`
    SELECT id, organization_id, scopes,
           (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= now())) AS inactive,
           (last_used_at IS NULL OR last_used_at < now() - ${`${LAST_USED_THROTTLE_SECONDS} seconds`}::interval) AS last_used_is_stale
    FROM api_keys
    WHERE hashed_key = ${hashApiKey(key, getServerEnv().API_KEY_HMAC_SECRET)}
  `;
  const row = rows[0];
  if (!row || row.inactive) return null;

  if (row.last_used_is_stale) {
    await rawSql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`;
  }

  return { organizationId: row.organization_id, keyId: row.id, scopes: row.scopes ?? [] };
}

export function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized", message: "Provide a valid API key as 'Authorization: Bearer sk_live_…'." },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

/** Returns the refusal to send, or `null` when the caller holds the scope. */
export function requireScope(caller: ApiCaller, scope: ApiScope): Response | null {
  if (caller.scopes.includes(scope)) return null;
  return Response.json(
    { error: "forbidden", message: `This API key is missing the '${scope}' scope.` },
    { status: 403 },
  );
}
