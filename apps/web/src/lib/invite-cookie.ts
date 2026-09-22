import "server-only";

import { cookies } from "next/headers";

/**
 * Carries a pending invitation across the sign-in wall.
 *
 * An invited person may have no account yet, so the redirect back to the invite
 * has to survive both login and signup. A short-lived cookie does that without
 * threading a `next` query parameter through two client-rendered auth forms
 * (which would drag `useSearchParams` and a Suspense boundary into both).
 *
 * The value is only an invitation id, and redeeming it still requires a session
 * whose email matches the invited address, so the cookie grants nothing on its own.
 */
const INVITE_COOKIE = "sentinel_invite";
const INVITE_TTL_SECONDS = 30 * 60;

export async function stashInvite(invitationId: string): Promise<void> {
  const store = await cookies();
  store.set(INVITE_COOKIE, invitationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: INVITE_TTL_SECONDS,
  });
}

/** Reads and clears the stashed invitation. Returns null when there is none. */
export async function takeInvite(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(INVITE_COOKIE)?.value;
  if (!value) return null;
  store.delete(INVITE_COOKIE);
  return value;
}
