"use server";

/**
 * Public status page subscriptions.
 *
 * Unlike every other action module this one has no session and no organization
 * scope: the audience for a status page is by definition people outside the
 * workspace. The slug is the only tenant key, and it is safe because a page has
 * to be published to be readable at all.
 *
 * Confirmation is double opt-in. Anyone can type anyone's address into a public
 * form, so an unconfirmed row is treated as if it does not exist: the fan-out in
 * the scheduler filters on `confirmed_at IS NOT NULL`.
 */

import { sql as rawSql } from "@sentinel/db";
import { generateToken } from "@sentinel/shared/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { appUrl, sendMail } from "@/lib/mail";
import { checkIpRateLimit, retryAfterMessage } from "@/lib/ratelimit";
import type { ActionState } from "@/lib/actions/settings";

const subscribeSchema = z.object({
  slug: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export async function subscribeToStatusPageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Origin only, no double-submit token: the audience here is anonymous, so
  // there is no guarantee a CSRF cookie was ever minted for this visitor.
  await assertSameOrigin();

  // Ahead of validation: this form sends mail to an address the submitter does
  // not have to own, so an unmetered caller turns it into a spam relay.
  const rate = await checkIpRateLimit("statusSubscribe");
  if (!rate.allowed) return { error: retryAfterMessage(rate) };

  const parsed = subscribeSchema.safeParse({
    slug: formData.get("slug"),
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { slug, email } = parsed.data;

  const [page] = await rawSql<{ id: string; title: string }[]>`
    SELECT id, title FROM status_pages WHERE slug = ${slug} AND published = true
  `;
  if (!page) return { error: "That status page is not available." };

  const confirmToken = generateToken(24);
  const unsubscribeToken = generateToken(24);

  // ON CONFLICT DO NOTHING rather than an upsert: re-submitting an address that
  // is already on the list must not mint a fresh token, or the form becomes a
  // way to spray confirmation mail at somebody else's inbox on repeat.
  const [row] = await rawSql<{ id: string }[]>`
    INSERT INTO status_page_subscribers (status_page_id, email, confirm_token, unsubscribe_token)
    VALUES (${page.id}, ${email}, ${confirmToken}, ${unsubscribeToken})
    ON CONFLICT (status_page_id, email) DO NOTHING
    RETURNING id
  `;

  // The reply is identical whether the row is new or was already there, so the
  // form cannot be used to test who is subscribed to a page.
  if (!row) return { ok: true };

  await sendMail({
    to: email,
    subject: `Confirm your subscription to ${page.title}`,
    text: [
      `You asked to receive status updates for ${page.title}.`,
      "",
      "Confirm your subscription:",
      appUrl(`/status/confirm/${confirmToken}`),
      "",
      "If this was not you, ignore this email and nothing further will be sent.",
    ].join("\n"),
  });

  return { ok: true };
}
