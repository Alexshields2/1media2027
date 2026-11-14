import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";

// Small secrets stored encrypted in the `secrets` table: AES-256-GCM with a key derived from
// AUTH_SECRET by HKDF-SHA256. Values never leave the server: no route returns them, no page shows
// them, and errors never include them. Changing AUTH_SECRET makes stored secrets unreadable
// (getSecret then returns null and the owner sets the integration up again).

const VERSION = "v1";

function deriveKey(authSecret: string | undefined): Buffer {
  if (!authSecret) throw new Error("AUTH_SECRET isn't set, so secrets can't be stored.");
  return Buffer.from(hkdfSync("sha256", authSecret, "1media-os/secrets", "aes-256-gcm/v1", 32));
}

/** "v1:<base64 iv | tag | ciphertext>". The name is bound as associated data, so a value can't be moved to another name. */
export function encryptSecret(plain: string, name: string, authSecret = process.env.AUTH_SECRET): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(authSecret), iv);
  cipher.setAAD(Buffer.from(name));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptSecret(stored: string, name: string, authSecret = process.env.AUTH_SECRET): string {
  const [v, b64] = stored.split(":");
  if (v !== VERSION || !b64) throw new Error("Unknown secret format.");
  const buf = Buffer.from(b64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(authSecret), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export async function setSecret(name: string, value: string): Promise<void> {
  const ciphertext = encryptSecret(value, name);
  await db.insert(schema.secrets).values({ name, ciphertext }).onConflictDoUpdate({ target: schema.secrets.name, set: { ciphertext, updatedAt: new Date() } });
}

/** The decrypted value, or null when missing or unreadable (e.g. AUTH_SECRET changed). */
export async function getSecret(name: string): Promise<string | null> {
  const [row] = await db.select().from(schema.secrets).where(eq(schema.secrets.name, name));
  if (!row) return null;
  try {
    return decryptSecret(row.ciphertext, name);
  } catch {
    console.error(`secret ${name} couldn't be decrypted (AUTH_SECRET changed?)`);
    return null;
  }
}

export async function hasSecret(name: string): Promise<boolean> {
  return (await getSecret(name)) !== null;
}

export async function deleteSecret(name: string): Promise<void> {
  await db.delete(schema.secrets).where(eq(schema.secrets.name, name));
}
