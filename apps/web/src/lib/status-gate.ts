import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getServerEnv } from "@sentinel/shared/env";

/**
 * Access control for password-protected status pages.
 *
 * A grant is an HMAC over the page id *and the password hash that authorised it*.
 * That binding is the whole design: rotating the password changes the hash, which
 * changes the expected HMAC, which silently invalidates every grant handed out
 * under the old password. No revocation table, no session rows to sweep — the
 * thing you rotate to lock people out is the thing the grant is derived from.
 *
 * The cookie is scoped to one page id, so a customer who unlocks the "API" page
 * does not thereby unlock the "Internal" page in the same organization.
 */

const COOKIE_PREFIX = "sentinel_sp_";

/** 12h. Long enough to survive a working day of refreshing during an outage. */
const GRANT_TTL_SECONDS = 12 * 60 * 60;

export function gateCookieName(pageId: string): string {
  return `${COOKIE_PREFIX}${pageId}`;
}

export function signGrant(pageId: string, passwordHash: string): string {
  return createHmac("sha256", getServerEnv().BETTER_AUTH_SECRET).update(`${pageId}.${passwordHash}`).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so the length check has to come first;
  // hex digests are fixed-width, making the early return non-informative in practice.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `null` passwordHash means the page is public, which every caller treats as granted. */
export async function hasStatusPageGrant(pageId: string, passwordHash: string | null): Promise<boolean> {
  if (passwordHash === null) return true;
  const cookie = (await cookies()).get(gateCookieName(pageId));
  if (!cookie) return false;
  return constantTimeEqual(cookie.value, signGrant(pageId, passwordHash));
}

export async function issueStatusPageGrant(pageId: string, passwordHash: string): Promise<void> {
  (await cookies()).set(gateCookieName(pageId), signGrant(pageId, passwordHash), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/status",
    maxAge: GRANT_TTL_SECONDS,
  });
}
