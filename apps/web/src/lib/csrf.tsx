import "server-only";

import { cookies, headers } from "next/headers";

import { getServerEnv } from "@sentinel/shared/env";
import { constantTimeEquals } from "@sentinel/shared/server";

import { CSRF_COOKIE, CSRF_COOKIE_OPTIONS, CSRF_FIELD, randomCsrfToken } from "@/lib/csrf-cookie";

/**
 * Double-submit CSRF, plus an Origin check that is the load-bearing half.
 *
 * `sameSite: "lax"` already blocks cross-site cookie delivery on POST in every
 * current browser, so this is defence in depth against the two cases it misses:
 * a same-site subdomain that an attacker controls, and a browser configured to
 * relax SameSite. The Origin comparison is the stronger of the two because it
 * cannot be forged by page script; the token covers the (rare) request that
 * arrives without an Origin-bearing navigation.
 */
const REJECTED = "Request rejected: this form was submitted from an untrusted origin.";

export async function issueCsrfToken(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CSRF_COOKIE)?.value;
  if (existing) return existing;

  const token = randomCsrfToken();
  try {
    jar.set(CSRF_COOKIE, token, CSRF_COOKIE_OPTIONS);
  } catch {
    // A Server Component render is not allowed to write cookies. The middleware
    // seeds the value on every document request, so the only renders that reach
    // here are ones it does not match, and those submit nothing.
  }
  return token;
}

/** Drop into every `<form action={serverAction}>` that mutates state. */
export async function CsrfInput() {
  const token = await issueCsrfToken();
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

/**
 * For actions bound to an id rather than a form body — there is no hidden field
 * to compare, so the Origin header carries the whole decision.
 */
export async function assertSameOrigin(): Promise<void> {
  const hdrs = await headers();
  const origin = hdrs.get("origin");
  if (origin !== new URL(getServerEnv().NEXT_PUBLIC_APP_URL).origin) throw new Error(REJECTED);
}

export async function assertCsrf(formData: FormData): Promise<void> {
  await assertSameOrigin();

  const jar = await cookies();
  const expected = jar.get(CSRF_COOKIE)?.value;
  const submitted = formData.get(CSRF_FIELD);
  if (!expected || typeof submitted !== "string" || !constantTimeEquals(expected, submitted)) {
    throw new Error(REJECTED);
  }
}
