import { clerkSetup } from "@clerk/testing/playwright";

import { DEMO_EMAIL, DEMO_PASSWORD } from "./fixtures";

const CLERK_API = "https://api.clerk.com/v1";

/**
 * Runs once before any project. Two jobs:
 *
 *  1. `clerkSetup()` trades the instance keys for a testing token and parks it
 *     in the environment, which is what lets the suite past Clerk's bot
 *     protection. It refuses a production secret key, so a misconfigured CI
 *     cannot point these specs at real users.
 *  2. Make sure the demo owner exists *in Clerk*. `pnpm db:seed` only creates
 *     the Postgres row; the app claims that row by matching email on first
 *     sign-in (see "claim the pre-Clerk account instead of colliding with
 *     it"), so the Clerk side has to be provisioned separately or there is
 *     nobody to sign in as.
 */
export default async function globalSetup(): Promise<void> {
  await clerkSetup();
  await ensureDemoUserExists();
}

async function ensureDemoUserExists(): Promise<void> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    // clerkSetup() has already thrown by this point if the key is missing, so
    // this only guards against a future reordering.
    throw new Error("CLERK_SECRET_KEY is required to provision the demo user");
  }

  if (await findUserId(secretKey, DEMO_EMAIL)) return;

  const response = await fetch(`${CLERK_API}/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [DEMO_EMAIL],
      password: DEMO_PASSWORD,
      skip_password_checks: true,
    }),
  });

  if (!response.ok) {
    // A parallel CI run can win the race between the lookup and the create, and
    // "that address is taken" is the outcome we wanted anyway.
    if (await findUserId(secretKey, DEMO_EMAIL)) return;
    throw new Error(`could not create the Clerk demo user (${response.status}): ${await response.text()}`);
  }
}

async function findUserId(secretKey: string, email: string): Promise<string | null> {
  const url = `${CLERK_API}/users?email_address=${encodeURIComponent(email)}&limit=1`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secretKey}` } });

  if (!response.ok) {
    throw new Error(`could not query Clerk for ${email} (${response.status}): ${await response.text()}`);
  }

  // The endpoint returns a bare array, not a paginated envelope.
  const users = (await response.json()) as Array<{ id: string }>;
  return users[0]?.id ?? null;
}
