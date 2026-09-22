/**
 * The choices an admin may pick from when minting an API key.
 *
 * Deliberately free of `server-only` and of any database import: the creation
 * form is a client component and has to render the same allowlist the action
 * validates against. One list, two consumers, no drift.
 */

export const API_SCOPES = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "incidents:write",
  "status_pages:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Read-only. A key created without an explicit choice can never mutate anything. */
export const DEFAULT_API_SCOPES: readonly ApiScope[] = ["monitors:read", "incidents:read"];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Days until a new key expires. `"0"` means it never does. */
export const EXPIRY_DAYS = ["0", "30", "90", "365"] as const;

export type ExpiryDays = (typeof EXPIRY_DAYS)[number];

export const EXPIRY_LABELS: Record<ExpiryDays, string> = {
  "0": "Never expires",
  "30": "30 days",
  "90": "90 days",
  "365": "365 days",
};

export function expiryFromDays(days: ExpiryDays): Date | null {
  const count = Number(days);
  return count === 0 ? null : new Date(Date.now() + count * 24 * 60 * 60 * 1000);
}
