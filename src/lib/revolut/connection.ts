import { randomBytes, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import type { RevolutConnection } from "../../db/schema";
import { deleteSecret, getSecret, setSecret } from "../secrets";
import { consentUrl, exchangeCode, refreshAccessToken, RevolutAuthError, type Env, type FetchLike } from "./api";
import { generateRsaKeyPair, issuerFor, selfSignedCertificate } from "./crypto";

// The one Revolut Business connection: key and certificate, client ID, tokens and their refresh.
// Secrets (private key, refresh and access tokens) live encrypted in `secrets`; the connection row
// only holds public data and timestamps. Nothing here returns a secret to a caller outside this folder.

const SECRET = { privateKey: "revolut.private_key", refresh: "revolut.refresh_token", access: "revolut.access_token" } as const;

export type RevolutStatus = "no_key" | "needs_client_id" | "not_authorised" | "connected" | "needs_reauth";

export async function getConnection(): Promise<RevolutConnection | null> {
  const [row] = await db.select().from(schema.revolutConnection).where(eq(schema.revolutConnection.id, 1));
  return row ?? null;
}

async function saveConnection(values: Partial<typeof schema.revolutConnection.$inferInsert>) {
  const v = { ...values, updatedAt: new Date() };
  await db.insert(schema.revolutConnection).values({ id: 1, ...v }).onConflictDoUpdate({ target: schema.revolutConnection.id, set: v });
}

/** The private key: REVOLUT_PRIVATE_KEY if set (PEM, "\n" escapes allowed), else the encrypted copy in the database. */
async function privateKeyPem(): Promise<string | null> {
  const env = process.env.REVOLUT_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (env) return env;
  return getSecret(SECRET.privateKey);
}

export const usesEnvKey = () => !!process.env.REVOLUT_PRIVATE_KEY?.trim();

/** True when the stored certificate was made from this private key. */
function certificateMatches(certPem: string | null | undefined, keyPem: string): boolean {
  if (!certPem) return false;
  try {
    const cert = new X509Certificate(certPem);
    const fromKey = createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "der" });
    return cert.publicKey.export({ type: "spki", format: "der" }).equals(fromKey);
  } catch {
    return false;
  }
}

/**
 * Step 1 of set-up: makes sure there is a private key (generated and stored encrypted if none) and a
 * self-signed certificate for it. Returns the public certificate only.
 */
export async function ensureKeyAndCertificate(): Promise<string> {
  let key = await privateKeyPem();
  if (!key) {
    key = generateRsaKeyPair().privateKeyPem;
    await setSecret(SECRET.privateKey, key);
  }
  const conn = await getConnection();
  if (certificateMatches(conn?.certificatePem, key)) return conn!.certificatePem!;
  const cert = selfSignedCertificate(key);
  await saveConnection({ certificatePem: cert });
  return cert;
}

export async function saveClientId(clientId: string) {
  const id = clientId.trim();
  if (!/^[A-Za-z0-9_\-]{8,128}$/.test(id)) throw new Error("That doesn't look like a Revolut client ID. Copy it from Revolut Business → APIs → Business API.");
  await saveConnection({ clientId: id });
}

export function revolutStatus(conn: RevolutConnection | null, hasKey: boolean, hasRefresh: boolean): RevolutStatus {
  if (!hasKey || !conn?.certificatePem) return "no_key";
  if (!conn.clientId) return "needs_client_id";
  if (conn.needsReauthAt) return "needs_reauth";
  if (!hasRefresh || !conn.connectedAt) return "not_authorised";
  return "connected";
}

/** Status without reading any secret's value out of this module. */
export async function currentStatus(): Promise<{ status: RevolutStatus; conn: RevolutConnection | null }> {
  const [conn, key, refresh] = await Promise.all([getConnection(), privateKeyPem(), getSecret(SECRET.refresh)]);
  return { status: revolutStatus(conn, !!key, !!refresh), conn };
}

/** Step 3: a fresh CSRF state and the Revolut consent URL to send the owner to. */
export async function startAuthorisation(redirectUri: string, env: Env = process.env): Promise<string> {
  const conn = await getConnection();
  if (!conn?.clientId) throw new Error("Paste the client ID from Revolut first.");
  const state = randomBytes(24).toString("base64url");
  await saveConnection({ oauthState: state, redirectUri });
  return consentUrl({ clientId: conn.clientId, redirectUri, state, env });
}

async function creds(conn: RevolutConnection, f?: FetchLike) {
  const key = await privateKeyPem();
  if (!key || !conn.clientId || !conn.redirectUri) throw new RevolutAuthError("Revolut isn't set up: generate the certificate, paste the client ID and authorise.");
  return { clientId: conn.clientId, issuer: issuerFor(conn.redirectUri), privateKey: key, fetch: f };
}

/** The consent redirect: checks the state, swaps the code for tokens and stores them encrypted. */
export async function completeAuthorisation(code: string, state: string | null, f?: FetchLike): Promise<void> {
  const conn = await getConnection();
  if (!conn?.clientId || !conn.oauthState) throw new Error("No Revolut authorisation was started. Click Authorise on Integrations.");
  // Revolut echoes state back; it must match the one this server issued.
  if (state !== conn.oauthState) throw new Error("This Revolut sign-in link is stale or wasn't started here. Click Authorise again.");
  const t = await exchangeCode(code, await creds(conn, f));
  if (!t.refreshToken) throw new Error("Revolut didn't return a refresh token. Authorise again.");
  await setSecret(SECRET.refresh, t.refreshToken);
  await setSecret(SECRET.access, t.accessToken);
  await saveConnection({
    oauthState: null,
    connectedAt: new Date(),
    accessTokenExpiresAt: t.accessTokenExpiresAt,
    refreshTokenExpiresAt: t.refreshTokenExpiresAt ?? null,
    needsReauthAt: null,
    lastError: null,
  });
}

/**
 * A valid access token, refreshed when it has under a minute left. When the refresh token no longer
 * works the connection is marked "needs re-authorising" (Integrations and the Home inbox show it).
 */
export async function getAccessToken(opts: { fetch?: FetchLike; now?: number } = {}): Promise<string> {
  const conn = await getConnection();
  if (!conn) throw new RevolutAuthError("Revolut isn't set up.");
  if (conn.needsReauthAt) throw new RevolutAuthError("Revolut needs re-authorising.");
  const now = opts.now ?? Date.now();
  const cached = await getSecret(SECRET.access);
  if (cached && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - now > 60_000) return cached;
  const refresh = await getSecret(SECRET.refresh);
  if (!refresh) throw new RevolutAuthError("Revolut isn't authorised yet.");
  try {
    const t = await refreshAccessToken(refresh, { ...(await creds(conn, opts.fetch)), now });
    await setSecret(SECRET.access, t.accessToken);
    if (t.refreshToken) await setSecret(SECRET.refresh, t.refreshToken);
    await saveConnection({
      accessTokenExpiresAt: t.accessTokenExpiresAt,
      ...(t.refreshTokenExpiresAt ? { refreshTokenExpiresAt: t.refreshTokenExpiresAt } : {}),
    });
    return t.accessToken;
  } catch (e) {
    if (e instanceof RevolutAuthError) {
      await markNeedsReauth(e.message);
      await deleteSecret(SECRET.access);
    }
    throw e;
  }
}

export async function markNeedsReauth(reason: string) {
  await saveConnection({ needsReauthAt: new Date(), lastError: `Needs re-authorising: ${reason}` });
}

/** Forgets the tokens (keeps the key, certificate and client ID so re-authorising is one click). */
export async function disconnectRevolut() {
  await deleteSecret(SECRET.refresh);
  await deleteSecret(SECRET.access);
  await saveConnection({ connectedAt: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, needsReauthAt: null, oauthState: null });
}

export async function saveSyncState(values: Pick<Partial<RevolutConnection>, "accounts" | "syncedThrough" | "lastSyncAt" | "lastSyncResult" | "lastError">) {
  await saveConnection(values);
}

/** For the Home action inbox: true when Revolut was connected and now needs the owner. */
export async function revolutNeedsAttention(): Promise<{ needsReauth: boolean; lastError: string | null }> {
  try {
    const conn = await getConnection();
    return { needsReauth: !!conn?.needsReauthAt || (!!conn?.refreshTokenExpiresAt && conn.refreshTokenExpiresAt.getTime() < Date.now()), lastError: conn?.lastError ?? null };
  } catch {
    return { needsReauth: false, lastError: null };
  }
}

/** Forces the next getAccessToken() to refresh (after Revolut rejects the cached access token). */
export async function expireAccessToken() {
  await deleteSecret(SECRET.access);
  await saveConnection({ accessTokenExpiresAt: null });
}
