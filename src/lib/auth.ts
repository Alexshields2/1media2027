// Single-password login for the dashboard. The cookie holds a hash of the password and
// AUTH_SECRET, so changing either logs everyone out. Uses Web Crypto so it runs in proxy.ts too.

export const SESSION_COOKIE = "om_session";

export async function sessionToken(): Promise<string | null> {
  const pw = process.env.ADMIN_PASSWORD;
  // AUTH_SECRET is optional: without it the (secret) database URL salts the cookie instead.
  const secret = process.env.AUTH_SECRET || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!pw || !secret) return null;
  const data = new TextEncoder().encode(`${pw}:${secret}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidSession(value: string | undefined): Promise<boolean> {
  const token = await sessionToken();
  return !!token && !!value && value.length === token.length && timingSafeEqual(value, token);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
