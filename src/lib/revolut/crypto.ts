import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Keys, the self-signed X.509 certificate Revolut asks for, and the signed JWT client assertion.
// Node can't create certificates on its own, so the certificate is built here as DER by hand (a
// minimal X.509 v3 cert, RSA + SHA-256). Tests check it with node:crypto's X509Certificate.

/** A new RSA-2048 key pair as PEM. The private key goes to the encrypted secrets table, never to the browser. */
export function generateRsaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

// ---------- minimal DER ----------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const derNull = () => Buffer.from([0x05, 0x00]);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const printable = (s: string) => tlv(0x13, Buffer.from(s, "ascii"));
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime for years before 2050, GeneralizedTime after (RFC 5280). */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const name = (cn: string, org: string, country: string) =>
  seq(set(seq(oid("2.5.4.6"), printable(country))), set(seq(oid("2.5.4.10"), utf8(org))), set(seq(oid("2.5.4.3"), utf8(cn))));

/**
 * A self-signed X.509 v3 certificate for the key pair, as PEM ("-----BEGIN CERTIFICATE-----").
 * This is what the owner uploads in Revolut Business → APIs → Business API. Valid 5 years by default.
 */
export function selfSignedCertificate(privateKeyPem: string, opts: { commonName?: string; organisation?: string; country?: string; days?: number; now?: Date } = {}): string {
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + (opts.days ?? 1825) * 86_400_000);
  const subject = name(opts.commonName ?? "1Media OS", opts.organisation ?? "1Media", opts.country ?? "IE");
  const algorithm = seq(oid(SHA256_WITH_RSA), derNull());
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(explicit(0, integer(Buffer.from([2]))), integer(serial), algorithm, subject, seq(time(notBefore), time(notAfter)), subject, spki);
  const signature = sign("sha256", tbs, key);
  const der = seq(tbs, algorithm, bitString(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// ---------- JWT client assertion ----------

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export const REVOLUT_JWT_AUDIENCE = "https://revolut.com";

/**
 * The signed JWT Revolut takes as client_assertion on /auth/token:
 * header {alg: RS256, typ: JWT}; payload {iss: the redirect URI's domain (no scheme), sub: client ID,
 * aud: "https://revolut.com", iat, exp}. Short-lived (5 minutes by default).
 */
export function clientAssertion(opts: { clientId: string; issuer: string; privateKey: string | KeyObject; now?: number; ttlSeconds?: number }): string {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: opts.issuer, sub: opts.clientId, aud: REVOLUT_JWT_AUDIENCE, iat, exp: iat + (opts.ttlSeconds ?? 300) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = typeof opts.privateKey === "string" ? createPrivateKey(opts.privateKey) : opts.privateKey;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), key))}`;
}

/** The JWT issuer for a redirect URI: its host, without scheme or path ("1media2027.vercel.app"). */
export function issuerFor(redirectUri: string): string {
  return new URL(redirectUri).host;
}
