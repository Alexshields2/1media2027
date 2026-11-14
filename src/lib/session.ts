import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { User } from "../db/schema";
import { SESSION_COOKIE, verifySession } from "./auth";

/** The signed-in user, or null. */
export async function currentUser(): Promise<User | null> {
  const id = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (id === null) return null;
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u && u.active ? u : null;
}

/** The signed-in user; sends anyone else to the login page. */
export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function allUsers(): Promise<User[]> {
  return db.select().from(schema.users).orderBy(asc(schema.users.id));
}

export function isManager(u: Pick<User, "role">): boolean {
  return u.role === "owner" || u.role === "manager";
}
