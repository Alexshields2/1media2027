// Sign-in flows. Each one verifies who the person is, then calls createSession().
import { and, count, eq, gt } from "drizzle-orm";
import { db, schema } from "../db";
import { audit } from "./audit";
import { RATE_LIMIT, bootstrapMode, isRateLimited, looksLikeEmail, nameFromEmail, normalizeEmail, type BootstrapMode } from "./auth-rules";
import { hashPassword, verifyPassword } from "./password";
import { createSession, requestMeta } from "./session";
import { cookies } from "next/headers";
import { SETUP_COOKIE, verifySigned } from "./session-token";

export async function userCount(): Promise<number> {
  const [r] = await db.select({ n: count() }).from(schema.users);
  return r?.n ?? 0;
}

export async function currentBootstrapMode(): Promise<BootstrapMode> {
  return bootstrapMode({ userCount: await userCount(), adminPassword: process.env.ADMIN_PASSWORD, ownerEmail: process.env.OWNER_EMAIL });
}

async function recentFailures(email: string, ip: string | null) {
  const since = new Date(Date.now() - RATE_LIMIT.windowMinutes * 60 * 1000);
  const base = and(eq(schema.auditLog.action, "auth.sign_in_failed"), gt(schema.auditLog.createdAt, since));
  const [byEmail] = await db.select({ n: count() }).from(schema.auditLog).where(and(base, eq(schema.auditLog.target, email)));
  const [byIp] = ip ? await db.select({ n: count() }).from(schema.auditLog).where(and(base, eq(schema.auditLog.ip, ip))) : [{ n: 0 }];
  return { email: byEmail?.n ?? 0, ip: byIp?.n ?? 0 };
}

const timingSafeConstEq = (a: string, b: string) => {
  // Compare without leaking length-by-length timing; both values are short.
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

export type SignInResult = { ok: true } | { ok: false; error: string } | { ok: "setup" };

/** Email + password sign-in, including the first-run ADMIN_PASSWORD bootstrap. Sets the cookie on success. */
export async function signInWithPassword(rawEmail: string, password: string): Promise<SignInResult> {
  const { ip } = await requestMeta();
  const email = normalizeEmail(rawEmail);
  const limitKey = email || "(admin password)";

  if (isRateLimited(await recentFailures(limitKey, ip))) {
    return { ok: false, error: `Too many attempts. Wait ${RATE_LIMIT.windowMinutes} minutes and try again.` };
  }
  const fail = async (error: string) => {
    await audit("auth.sign_in_failed", { target: limitKey, ip });
    return { ok: false as const, error };
  };

  const mode = await currentBootstrapMode();
  if (mode === "closed") return { ok: false, error: "No accounts yet. Set ADMIN_PASSWORD on the server to create the first owner." };

  if (mode !== "accounts") {
    // First run: only the shared ADMIN_PASSWORD works.
    const admin = process.env.ADMIN_PASSWORD ?? "";
    if (!timingSafeConstEq(password, admin)) return fail("Wrong password.");
    if (mode === "setup") return { ok: "setup" };
    const ownerEmail = normalizeEmail(process.env.OWNER_EMAIL ?? "");
    const owner = await createUser({
      email: ownerEmail,
      name: process.env.OWNER_NAME?.trim() || nameFromEmail(ownerEmail),
      role: "owner",
      password: admin,
    });
    await audit("auth.setup_owner", { userId: owner.id, target: `user:${owner.id}`, detail: { via: "OWNER_EMAIL" }, ip });
    await createSession(owner, "admin_password");
    await audit("auth.sign_in", { userId: owner.id, target: ownerEmail, detail: { method: "admin_password" }, ip });
    return { ok: true };
  }

  if (!looksLikeEmail(email)) return fail("Enter your email and password.");
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  // Always run a hash check so unknown emails take as long as known ones.
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) return fail("Wrong email or password.");
  if (!user.active) return fail("This account is switched off. Ask an owner.");

  await createSession(user, "password");
  await audit("auth.sign_in", { userId: user.id, target: email, detail: { method: "password" }, ip });
  return { ok: true };
}

// A valid hash of a random string, so failed lookups still cost one scrypt.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

export async function createUser(input: { email: string; name: string; role: "owner" | "team"; password?: string }) {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) throw new Error("Enter a valid email address.");
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) throw new Error("Someone with that email already has an account.");
  const [u] = await db.insert(schema.users).values({ email, name: input.name.trim() || nameFromEmail(email), role: input.role, passwordHash }).returning();
  return u;
}

/** Number of active owners, to stop the last one being demoted or switched off. */
export async function activeOwnerCount(): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(schema.users)
    .where(and(eq(schema.users.role, "owner"), eq(schema.users.active, true)));
  return r?.n ?? 0;
}


/** True while the visitor holds a fresh setup cookie (they entered ADMIN_PASSWORD on first run). */
export async function hasSetupPass(): Promise<boolean> {
  const v = await verifySigned((await cookies()).get(SETUP_COOKIE)?.value);
  const m = v?.match(/^setup:(\d+)$/);
  return !!m && Number(m[1]) > Date.now();
}

