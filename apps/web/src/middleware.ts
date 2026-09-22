import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

import { CSRF_COOKIE, CSRF_COOKIE_OPTIONS, randomCsrfToken } from "@/lib/csrf-cookie";

/**
 * Security headers for every response, and the one place the CSRF cookie is
 * minted — a Server Component render cannot set a cookie, so seeding it here is
 * what makes `<CsrfInput />` able to render a value that will match on submit.
 *
 * Wrapped in `clerkMiddleware` so `auth()` is available to Server Components,
 * Route Handlers and Server Actions. `clerk init` declined to do this
 * automatically ("unsupported shape"), because the response here is built and
 * mutated rather than returned straight from `NextResponse.next()`. Composing
 * by hand is the whole point: dropping this middleware to let Clerk own the
 * file would silently remove the CSRF seed and every security header.
 */

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";
const HSTS = "max-age=63072000; includeSubDomains; preload";

/**
 * Clerk serves its SDK and opens its sign-in widget from the Frontend API
 * host, and fronts bot protection with Cloudflare Turnstile. Without these the
 * existing `script-src 'self'` blocks Clerk outright and every auth screen
 * renders empty with a CSP violation in the console.
 *
 * `*.clerk.accounts.dev` covers development instances. A production instance
 * served from a custom domain (clerk.<your-domain>) has to be added here too,
 * or the same silent breakage ships to production.
 */
const CLERK_SCRIPT_SRC = "https://*.clerk.accounts.dev https://challenges.cloudflare.com";
const CLERK_CONNECT_SRC = "https://*.clerk.accounts.dev";
const CLERK_FRAME_SRC = "https://*.clerk.accounts.dev https://challenges.cloudflare.com";
const CLERK_IMG_SRC = "https://img.clerk.com";

/**
 * Next inlines its bootstrap and route-announcer scripts, so `'unsafe-inline'`
 * for scripts is the cost of not threading a nonce through every render; the
 * dev server additionally compiles with `eval` and talks to HMR over a
 * websocket. `frame-ancestors` is what actually decides embeddability — the
 * `X-Frame-Options` header below is only for browsers that predate CSP level 2.
 */
function contentSecurityPolicy(embeddable: boolean): string {
  const development = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${CLERK_SCRIPT_SRC}${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${CLERK_IMG_SRC}`,
    "font-src 'self' data:",
    `connect-src 'self' https: ${CLERK_CONNECT_SRC}${development ? " ws: wss:" : ""}`,
    `frame-src 'self' ${CLERK_FRAME_SRC}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embeddable ? "*" : "'none'"}`,
  ].join("; ");
}

function withSecurityHeaders(request: NextRequest): NextResponse {
  // Public status pages are meant to be embedded in customers' own dashboards.
  const embeddable = request.nextUrl.pathname.startsWith("/status/");

  const existing = request.cookies.get(CSRF_COOKIE)?.value;
  const csrfToken = existing ?? randomCsrfToken();
  if (!existing) request.cookies.set(CSRF_COOKIE, csrfToken);

  const response = NextResponse.next({ request: { headers: request.headers } });
  if (!existing) response.cookies.set(CSRF_COOKIE, csrfToken, CSRF_COOKIE_OPTIONS);

  response.headers.set("Content-Security-Policy", contentSecurityPolicy(embeddable));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  if (!embeddable) response.headers.set("X-Frame-Options", "DENY");
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", HSTS);
  }

  return response;
}

export default clerkMiddleware((_auth, request) => withSecurityHeaders(request));

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
