// Server-side sessions and the guards every page, server action and route handler uses.
//
// Sign-in methods all end in createSession(), so adding magic links later means: a table of
// one-time tokens, a page that emails the link, and a route that checks the token and calls
// createSession(user, "magic_link"). Nothing else changes.
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import type { User } from "../db/schema";
import { isSessionUsable } from "./auth-rules";
import { ForbiddenError, can, type Permission } from "./roles";
import { SESSION_COOKIE, SESSION_DAYS, newSessionId, signValue, verifySigned } from "./session-token";

export type CurrentUser = Pick<User, "id" | "email" | "name" | "role">;

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

/** Creates a session row for this user and sets the signed cookie. */
export async function createSession(user: Pick<User, "id">, method: "password" | "admin_password" | "magic_link") {
  const { ip, userAgent } = await requestMeta();
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({ id, userId: user.id, method, ip, userAgent, expiresAt });
  await db.update(schema.users).set({ lastSignInAt: new Date() }).where(eq(schema.users.id, user.id));
  (await cookies()).set(SESSION_COOKIE, await signValue(id), cookieOptions(SESSION_DAYS * 24 * 60 * 60));
}

/** The signed-in person for this request, or null. Checks the session row every time (revocable). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const id = await verifySigned((await cookies()).get(SESSION_COOKIE)?.value);
  if (!id) return null;
  try {
    const [row] = await db
      .select({ s: schema.sessions, u: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())));
    if (!row || !isSessionUsable(row.s, row.u)) return null;
    return { id: row.u.id, email: row.u.email, name: row.u.name, role: row.u.role };
  } catch (e) {
    console.error("session lookup failed", e);
    return null;
  }
});

/** For pages: the signed-in person, or a redirect to /login. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For server actions and route handlers: throws unless the person has this permission. */
export async function requirePermission(permission: Permission, what?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new ForbiddenError("do that while signed out");
  if (!can(user.role, permission)) throw new ForbiddenError(what);
  return user;
}

/** For server actions: throws unless someone is signed in. */
export async function requireSignedIn(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new ForbiddenError("do that while signed out");
  return user;
}

/** Revokes the current session and clears the cookie. */
export async function endSession() {
  const jar = await cookies();
  const id = await verifySigned(jar.get(SESSION_COOKIE)?.value);
  if (id) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, id));
  jar.delete(SESSION_COOKIE);
}

/** Signs a person out everywhere (deactivation, password reset). */
export async function revokeAllSessions(userId: number) {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}
