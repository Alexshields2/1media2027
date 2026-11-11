// The session cookie: "<session id>.<HMAC-SHA256(id)>". The signature stops forged or guessed ids
// cheaply (proxy.ts checks it on every request without a database call); the server-side session
// row (src/lib/session.ts) is the real check, so a session can be revoked.
// Uses Web Crypto so it works in proxy.ts as well as in server code.
import { databaseUrl } from "../db/url";

export const SESSION_COOKIE = "om_session";
export const SETUP_COOKIE = "om_setup";
export const SESSION_DAYS = 30;

type Env = Record<string, string | undefined>;

/** AUTH_SECRET signs cookies. Without it, the (secret) database URL is used instead. */
export function authSecret(env: Env = process.env): string | null {
  return env.AUTH_SECRET || databaseUrl(env) || null;
}

const enc = new TextEncoder();

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  return toB64url(sig);
}

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new random session id (256 bits). */
export function newSessionId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signValue(value: string, secret = authSecret()): Promise<string> {
  if (!secret) throw new Error("AUTH_SECRET (or a database URL) is needed to sign sessions.");
  return `${value}.${await hmac(secret, value)}`;
}

/** Returns the value if the signature is valid, else null. */
export async function verifySigned(signed: string | undefined | null, secret = authSecret()): Promise<string | null> {
  if (!signed || !secret) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const expected = await hmac(secret, value);
  return safeEqual(signed.slice(dot + 1), expected) ? value : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
