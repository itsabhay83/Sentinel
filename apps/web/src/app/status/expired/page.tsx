import type { Metadata } from "next";
import { Unlink } from "lucide-react";

export const metadata: Metadata = {
  title: "Link no longer valid",
  robots: { index: false, follow: false },
};

/**
 * Landing spot for a confirmation or unsubscribe token that no longer resolves.
 * It deliberately says nothing about which page the token belonged to, because
 * an expired token is still an untrusted string out of an email.
 */
export default function ExpiredLinkPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10 text-center">
      <Unlink className="mx-auto size-8 text-ink-3" />
      <h1 className="mt-4 text-lg font-semibold text-ink">This link is no longer valid</h1>
      <p className="mt-2 text-sm text-ink-2">
        It may already have been used, or the subscription was removed. Open the status page again
        to sign up.
      </p>
    </main>
  );
}
