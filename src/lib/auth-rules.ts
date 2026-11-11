// Pure sign-in rules (no database, no cookies) so they can be unit-tested.

export const RATE_LIMIT = {
  windowMinutes: 15,
  perEmail: 5, // failed attempts for one email within the window
  perIp: 20, // failed attempts from one IP within the window
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Too many recent failures for this email or this IP? */
export function isRateLimited(failures: { email: number; ip: number }): boolean {
  return failures.email >= RATE_LIMIT.perEmail || failures.ip >= RATE_LIMIT.perIp;
}

/** Is a stored session row still good for this user? */
export function isSessionUsable(
  session: { expiresAt: Date; revokedAt: Date | null } | null | undefined,
  user: { active: boolean } | null | undefined,
  now = new Date(),
): boolean {
  if (!session || !user) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  return user.active;
}

/**
 * First run: while there are no users, the old shared ADMIN_PASSWORD still signs in.
 *  - "owner_from_env": OWNER_EMAIL is set, so ADMIN_PASSWORD creates that owner and signs in.
 *  - "setup": no OWNER_EMAIL, so ADMIN_PASSWORD leads to the one-time /setup page.
 *  - "closed": no users and no ADMIN_PASSWORD: nobody can get in until one is set.
 *  - "accounts": users exist; only per-person sign-in works and ADMIN_PASSWORD is ignored.
 */
export type BootstrapMode = "owner_from_env" | "setup" | "closed" | "accounts";

export function bootstrapMode(input: { userCount: number; adminPassword?: string; ownerEmail?: string }): BootstrapMode {
  if (input.userCount > 0) return "accounts";
  if (!input.adminPassword) return "closed";
  return input.ownerEmail && looksLikeEmail(normalizeEmail(input.ownerEmail)) ? "owner_from_env" : "setup";
}

/** Display name from an email when none is given: "jamie.smith@x.ie" -> "Jamie Smith". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || email;
}
