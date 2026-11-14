// Per-person login. The cookie is "<userId>.<expiry>.<signature>", signed with HMAC-SHA256.
// Uses Web Crypto only, so proxy.ts can check it without touching the database.

export const SESSION_COOKIE = "om_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function secret(): string | null {
  // AUTH_SECRET is optional: without it the (secret) database URL signs the cookie instead.
  return process.env.AUTH_SECRET || process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

/** True when the server can issue logins at all. */
export function authConfigured(): boolean {
  return !!secret();
}

async function hmac(data: string): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signSession(userId: number, now = Date.now()): Promise<string | null> {
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE;
  const sig = await hmac(`${userId}.${exp}`);
  return sig ? `${userId}.${exp}.${sig}` : null;
}

/** The user id in a valid, unexpired cookie, else null. */
export async function verifySession(value: string | undefined, now = Date.now()): Promise<number | null> {
  if (!value) return null;
  const [id, exp, sig] = value.split(".");
  if (!id || !exp || !sig || !/^\d+$/.test(id) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) * 1000 < now) return null;
  const expected = await hmac(`${id}.${exp}`);
  if (!expected || expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  return Number(id);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
