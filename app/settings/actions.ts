"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { activeOwnerCount, createUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { createSession, requirePermission, requireSignedIn, revokeAllSessions } from "@/lib/session";

function back(params: Record<string, string>): never {
  redirect(`/settings?${new URLSearchParams(params)}`);
}
const text = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string).trim() : "");
const role = z.enum(["owner", "team"]);

export async function addUserAction(form: FormData) {
  const me = await requirePermission("manage_users", "add people");
  const password = (form.get("password") as string) ?? "";
  const problem = passwordProblem(password);
  if (problem) back({ error: `Temporary password: ${problem}` });
  let user;
  try {
    user = await createUser({ email: text(form, "email"), name: text(form, "name"), role: role.parse(form.get("role")), password });
  } catch (e) {
    back({ error: e instanceof Error ? e.message : "Couldn't add that person." });
  }
  await audit("user.create", { userId: me.id, target: `user:${user.id}`, detail: { email: user.email, role: user.role } });
  revalidatePath("/settings");
  back({ ok: `Added ${user.name}. Give them their temporary password; they can change it in Settings.` });
}

export async function updateUserAction(id: number, form: FormData) {
  const me = await requirePermission("manage_users", "change people");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) back({ error: "That person no longer exists." });
  const nextRole = role.parse(form.get("role"));
  const nextActive = form.get("active") === "on";
  const name = text(form, "name") || u.name;
  const losesOwner = u.role === "owner" && u.active && (nextRole !== "owner" || !nextActive);
  if (losesOwner && (await activeOwnerCount()) <= 1) back({ error: "There must always be at least one active owner." });
  if (id === me.id && !nextActive) back({ error: "You can't switch off your own account." });

  await db.update(schema.users).set({ role: nextRole, active: nextActive, name }).where(eq(schema.users.id, id));
  if (!nextActive || nextRole !== u.role) await revokeAllSessions(id); // takes effect on their next click
  await audit("user.update", { userId: me.id, target: `user:${id}`, detail: { role: [u.role, nextRole], active: [u.active, nextActive], name } });
  revalidatePath("/settings");
  if (id === me.id && nextRole !== u.role) redirect("/login");
  back({ ok: `Saved ${name}.` });
}

export async function resetPasswordAction(id: number, form: FormData) {
  const me = await requirePermission("manage_users", "reset passwords");
  const password = (form.get("password") as string) ?? "";
  const problem = passwordProblem(password);
  if (problem) back({ error: problem });
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) back({ error: "That person no longer exists." });
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, id));
  await revokeAllSessions(id);
  await audit("user.reset_password", { userId: me.id, target: `user:${id}` });
  if (id === me.id) redirect("/login");
  back({ ok: `New password set for ${u.name}. They've been signed out everywhere.` });
}

export async function changeOwnPasswordAction(form: FormData) {
  const me = await requireSignedIn();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
  if (!(await verifyPassword((form.get("current") as string) ?? "", u?.passwordHash))) back({ error: "Your current password is wrong." });
  const password = (form.get("password") as string) ?? "";
  const problem = passwordProblem(password);
  if (problem) back({ error: problem });
  if (password !== form.get("confirm")) back({ error: "The two new passwords don't match." });
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, me.id));
  await revokeAllSessions(me.id); // sign out other devices
  await createSession(me, "password"); // keep this one signed in
  await audit("user.change_password", { userId: me.id, target: `user:${me.id}` });
  back({ ok: "Password changed. Other devices have been signed out." });
}
