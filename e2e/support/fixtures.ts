/**
 * Values the seed script guarantees. These are fixtures, not configuration:
 * `pnpm db:seed` is deterministic, so a spec that stops matching them is
 * reporting a real change in the seeded demo org rather than drift.
 */
export const DEMO_EMAIL = "demo@sentinel.dev";
export const DEMO_PASSWORD = "sentinel123";

export const STATUS_PAGE_SLUG = "acme";
export const STATUS_PAGE_TITLE = "Acme Rockets Status";

/**
 * Relative to the repo root, which is where pnpm runs package scripts from.
 * Written by `support/auth.setup.ts` and consumed by the specs that need an
 * already-signed-in context. Never committed — it holds a live session cookie.
 */
export const STORAGE_STATE = "e2e/.auth/demo.json";

/** The CSRF cookie/field pair minted in `apps/web/src/middleware.ts`. */
export const CSRF_COOKIE = "sentinel_csrf";
export const CSRF_FIELD = "_csrf";

/** 32 random bytes, hex-encoded — see `randomCsrfToken()`. */
export const CSRF_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const MONITOR_DETAIL_PATTERN = /\/monitors\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
