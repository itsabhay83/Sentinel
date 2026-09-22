/**
 * Double opt-in confirmation link.
 *
 * Lives at /status/confirm/<token> rather than under the page's own slug so the
 * token alone is enough to resolve the subscription — the recipient never has to
 * be handed a URL that also encodes which page they signed up for.
 *
 * Deliberately idempotent: the token is not cleared on use. It is a UNIQUE NOT
 * NULL column, so there is no blank value to retire it to, and re-clicking a
 * confirmation link out of an old email should land on the status page rather
 * than on an error.
 */

import { sql as rawSql } from "@sentinel/db";
import { appUrl } from "@/lib/mail";

type Params = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { token } = await params;

  const [row] = await rawSql<{ slug: string }[]>`
    UPDATE status_page_subscribers s
    SET confirmed_at = coalesce(s.confirmed_at, now())
    FROM status_pages p
    WHERE p.id = s.status_page_id AND s.confirm_token = ${token}
    RETURNING p.slug
  `;

  if (!row) return Response.redirect(appUrl("/status/expired"), 303);
  return Response.redirect(appUrl(`/status/${row.slug}?subscribed=1`), 303);
}
