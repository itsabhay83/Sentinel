"use server";

/**
 * Auth Server Actions: signup, login, logout, organization creation.
 *
 * These return `{ error }` objects rather than throwing, because they are bound
 * to `useActionState` and the failure cases here (wrong password, email taken)
 * are ordinary user outcomes, not exceptions. A failed CSRF or origin check is
 * the exception: it cannot come from a user operating the form.
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, sql as rawSql } from "@sentinel/db";
import { accounts, members, organizations, users } from "@sentinel/db/schema";
import { generateId, hashPassword, slugify, verifyPassword } from "@sentinel/shared/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { createSession, destroySession, getSession, requireSession } from "@/lib/auth";
import { assertCsrf, assertSameOrigin } from "@/lib/csrf";
import { rateLimited } from "@/lib/form-state";
import { takeInvite } from "@/lib/invite-cookie";
import { checkCredentialRateLimit, checkIpRateLimit } from "@/lib/ratelimit";
import { sendEmailVerification } from "@/lib/verification";

export type ActionState = { error?: string } | undefined;

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  organization: z.string().trim().min(1, "Organization name is required").max(120),
});

/**
 * Signup creates the user, the credential account, the organization and the
 * owner membership in one transaction. A half-created signup — a user with no
 * org — would land on `/onboarding` forever, so it must be all or nothing.
 */
export async function signupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const limit = await checkIpRateLimit("signup");
  if (!limit.allowed) return rateLimited(limit);

  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    organization: formData.get("organization"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, password, organization } = parsed.data;

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { error: "An account with that email already exists" };
  }

  const userId = generateId("usr");
  const orgId = generateId("org");
  const passwordHash = await hashPassword(password);

  // Slugs must be unique; append a short suffix rather than failing the signup
  // over a name collision the user has no way to predict.
  let slug = slugify(organization);
  const slugTaken = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (slugTaken.length > 0) slug = `${slug}-${orgId.slice(-4).toLowerCase()}`;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, name, email, emailVerified: false });
      await tx.insert(accounts).values({
        id: generateId("acc"),
        accountId: email,
        providerId: "credential",
        userId,
        password: passwordHash,
      });
      await tx.insert(organizations).values({ id: orgId, name: organization, slug, plan: "free" });
      await tx.insert(members).values({ id: generateId("mem"), organizationId: orgId, userId, role: "owner" });
    });
  } catch {
    return { error: "Could not create the account. Please try again." };
  }

  await recordAudit({ action: "auth.signup", organizationId: orgId, actorUserId: userId, actorEmail: email });
  await recordAudit({
    action: "org.created",
    organizationId: orgId,
    actorUserId: userId,
    actorEmail: email,
    targetType: "organization",
    targetId: orgId,
    metadata: { name: organization, slug, plan: "free" },
  });
  await sendEmailVerification(email, userId);

  await createSession(userId, orgId);
  const invite = await takeInvite();
  redirect(invite ? `/invite/${invite}` : "/dashboard");
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { email, password } = parsed.data;

  const limit = await checkCredentialRateLimit("login", email);
  if (!limit.allowed) return rateLimited(limit);

  const rows = await db
    .select({ userId: users.id, mfaEnabled: users.mfaEnabled, password: accounts.password })
    .from(users)
    .innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, "credential")))
    .where(eq(users.email, email))
    .limit(1);

  const row = rows[0];
  // Same message and comparable work for "no such user" and "wrong password",
  // so the form cannot be used to enumerate which emails have accounts.
  const ok = row?.password ? await verifyPassword(password, row.password) : await verifyPassword(password, "scrypt$32768$8$1$00$00");
  if (!row || !ok) {
    await recordAudit({ action: "auth.login.failed", actorUserId: row?.userId ?? null, actorEmail: email });
    return { error: "Incorrect email or password" };
  }

  const [membership] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, row.userId))
    .limit(1);

  await createSession(row.userId, membership?.organizationId ?? null);
  await recordAudit({
    action: "auth.login.success",
    organizationId: membership?.organizationId ?? null,
    actorUserId: row.userId,
    actorEmail: email,
  });

  // The session exists but is not yet usable: `createSession` left
  // `mfa_verified_at` null, and `requireSession()` refuses it until the
  // challenge stamps it.
  if (row.mfaEnabled) redirect("/mfa-challenge");

  // A pending invite outranks onboarding: accepting it gives them an org, so
  // sending them to create one first would leave them in the wrong workspace.
  const invite = await takeInvite();
  if (invite) redirect(`/invite/${invite}`);
  redirect(membership ? "/dashboard" : "/onboarding");
}

export async function logoutAction(): Promise<void> {
  await assertSameOrigin();

  const session = await getSession();
  await destroySession();
  if (session) {
    await recordAudit({
      action: "auth.logout",
      organizationId: session.org?.id ?? null,
      actorUserId: session.user.id,
      actorEmail: session.user.email,
    });
  }
  redirect("/login");
}

const orgSchema = z.object({ name: z.string().trim().min(1, "Organization name is required").max(120) });

export async function createOrganizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await assertCsrf(formData);

  const session = await requireSession();
  const parsed = orgSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const orgId = generateId("org");
  let slug = slugify(parsed.data.name);
  const taken = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (taken.length > 0) slug = `${slug}-${orgId.slice(-4).toLowerCase()}`;

  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: parsed.data.name, slug, plan: "free" });
    await tx.insert(members).values({ id: generateId("mem"), organizationId: orgId, userId: session.user.id, role: "owner" });
  });

  await rawSql`UPDATE sessions SET active_organization_id = ${orgId} WHERE token = ${session.token}`;
  await recordAudit({
    action: "org.created",
    organizationId: orgId,
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    targetType: "organization",
    targetId: orgId,
    metadata: { name: parsed.data.name, slug, plan: "free" },
  });
  redirect("/dashboard");
}
