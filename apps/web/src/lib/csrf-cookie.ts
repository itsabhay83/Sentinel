/**
 * The half of the CSRF scheme both runtimes can see.
 *
 * The middleware mints the cookie on the Edge runtime, where `node:crypto` and
 * `next/headers` do not exist; the server helpers in `csrf.tsx` verify it in
 * Node. Neither can import the other, so the cookie name, the field name and
 * the token generator live here with no framework imports at all.
 */
export const CSRF_COOKIE = "sentinel_csrf";
export const CSRF_FIELD = "_csrf";

const TOKEN_BYTES = 32;

/**
 * Not httpOnly on purpose: the double-submit pattern needs the page that
 * renders a form to read the same value it puts in the hidden field. The cookie
 * grants nothing on its own — it only has to be unguessable and same-origin.
 */
export const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

export function randomCsrfToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
