"use server";

/**
 * Session revocation. Both actions are bound to an id rather than a form body,
 * so `assertSameOrigin()` carries the whole CSRF decision — there is no field to
 * double-submit.
 */
import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { revokeOtherSessions, revokeSession } from "@/lib/sessions";

export async function revokeSessionAction(sessionId: string): Promise<void> {
  await assertSameOrigin();

  const session = await requireSession();
  const revoked = await revokeSession(session.user.id, sessionId);
  if (revoked) {
    await recordAudit({
      action: "auth.session.revoked",
      organizationId: session.org?.id ?? null,
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      targetType: "session",
      targetId: sessionId,
    });
  }

  revalidatePath("/settings/security");
}

export async function revokeAllOtherSessionsAction(): Promise<void> {
  await assertSameOrigin();

  const session = await requireSession();
  const revoked = await revokeOtherSessions(session.user.id, session.id);
  await recordAudit({
    action: "auth.sessions.revoked_all",
    organizationId: session.org?.id ?? null,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    metadata: { revoked },
  });

  revalidatePath("/settings/security");
}
