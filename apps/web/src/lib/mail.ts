import "server-only";

import { getServerEnv } from "@sentinel/shared/env";

/**
 * Transactional mail for the web app (invites, subscriber confirmations).
 *
 * Deliberately a copy of the scheduler's `sendEmail` rather than a shared
 * package: the two have opposite failure contracts. An alert that fails to send
 * must throw so the delivery row is retried; an invite that fails to send must
 * not roll back the invitation row the admin can still copy a link for. Sharing
 * the transport would mean sharing that decision, so only the ~15 lines of
 * Resend call shape are duplicated.
 */
export type Mail = { to: string; subject: string; text: string };

export type MailResult = { delivered: boolean; error?: string };

export async function sendMail({ to, subject, text }: Mail): Promise<MailResult> {
  const env = getServerEnv();

  // Same stdout transport the scheduler uses, so a local dev run without a
  // Resend key still shows the confirmation and invite links in the logs.
  if (!env.RESEND_API_KEY) {
    console.info(JSON.stringify({ msg: "mail (stdout transport)", to, subject, text }));
    return { delivered: false };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to: [to], subject, text }),
    });
    if (!response.ok) return { delivered: false, error: `resend ${response.status}` };
    return { delivered: true };
  } catch (error) {
    return { delivered: false, error: error instanceof Error ? error.message : "send failed" };
  }
}

export function appUrl(path: string): string {
  return `${getServerEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}${path}`;
}
