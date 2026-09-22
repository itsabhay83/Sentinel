/**
 * One-click unsubscribe link, carried in the footer of every subscriber email.
 *
 * Deleting the row rather than flagging it means the address is free to sign up
 * again later, and it keeps the fan-out query a plain join with no tombstone
 * filter to forget.
 */

import { sql as rawSql } from "@sentinel/db";
import { appUrl } from "@/lib/mail";

type Params = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { token } = await params;

  const [row] = await rawSql<{ slug: string }[]>`
    DELETE FROM status_page_subscribers s
    USING status_pages p
    WHERE p.id = s.status_page_id AND s.unsubscribe_token = ${token}
    RETURNING p.slug
  `;

  if (!row) return Response.redirect(appUrl("/status/expired"), 303);
  return Response.redirect(appUrl(`/status/${row.slug}?unsubscribed=1`), 303);
}
