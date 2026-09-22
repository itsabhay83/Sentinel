import { UserProfile } from "@clerk/nextjs";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

/**
 * Password, two-factor enrolment, email addresses and active devices all moved
 * to Clerk, so this page is now a frame around Clerk's own account UI rather
 * than three hand-built cards over the local `sessions` and `user_mfa_factors`
 * tables. Those tables -- and the forms that drove them -- are gone.
 */
export default function SecuritySettings() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-xl font-semibold text-ink">Security</h1>
      <p className="mt-1 text-sm text-ink-2">
        Manage your password, two-factor authentication and signed-in devices.
      </p>
      <div className="mt-6">
        <UserProfile routing="hash" />
      </div>
    </div>
  );
}
