// Password hashing with scrypt from node:crypto (no native dependencies).
// Stored format: scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>, so parameters can be raised later
// without breaking existing hashes.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!expected.length) return false;
  try {
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  return null;
}
