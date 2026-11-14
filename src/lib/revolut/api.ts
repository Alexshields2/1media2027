import { clientAssertion } from "./crypto";

// Revolut Business API over plain fetch (no SDK). The fetch function is injectable so tests mock the
// HTTP layer and never call Revolut. Errors never include tokens or the private key.
//
//   REVOLUT_ENV=sandbox    -> sandbox-b2b.revolut.com / sandbox-business.revolut.com
//   anything else          -> production (b2b.revolut.com / business.revolut.com)

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const REVOLUT_URLS = {
  production: { api: "https://b2b.revolut.com/api/1.0", consent: "https://business.revolut.com/app-confirm" },
  sandbox: { api: "https://sandbox-b2b.revolut.com/api/1.0", consent: "https://sandbox-business.revolut.com/app-confirm" },
} as const;

export function revolutEnv(env: Env = process.env): keyof typeof REVOLUT_URLS {
  return env.REVOLUT_ENV === "sandbox" ? "sandbox" : "production";
}

export const revolutUrls = (env: Env = process.env) => REVOLUT_URLS[revolutEnv(env)];

/** The page where the owner approves 1Media OS in Revolut Business (read-only scope). */
export function consentUrl(opts: { clientId: string; redirectUri: string; state: string; env?: Env }): string {
  const u = new URL(revolutUrls(opts.env).consent);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "READ");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/** The refresh token (or authorisation) no longer works: the owner must authorise again. */
export class RevolutAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevolutAuthError";
  }
}

export class RevolutApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RevolutApiError";
  }
}

export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Only on the first exchange (and if Revolut rotates it on refresh). */
  refreshToken?: string;
  refreshTokenExpiresAt?: Date | null;
}

interface Creds {
  clientId: string;
  issuer: string;
  privateKey: string;
  fetch?: FetchLike;
  env?: Env;
  now?: number;
}

/** A short, token-free description of a failed response. */
async function describe(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as Record<string, unknown>;
    detail = String(body.error_description ?? body.message ?? body.error ?? "");
  } catch {
    /* not JSON */
  }
  return `Revolut answered ${res.status}${detail ? `: ${detail.replace(/[A-Za-z0-9_\-.]{40,}/g, "…").slice(0, 160)}` : ""}`;
}

async function tokenRequest(form: Record<string, string>, c: Creds): Promise<TokenSet> {
  const f = c.fetch ?? fetch;
  const body = new URLSearchParams({
    ...form,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion({ clientId: c.clientId, issuer: c.issuer, privateKey: c.privateKey, now: c.now }),
  });
  const res = await f(`${revolutUrls(c.env).api}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const msg = await describe(res);
    // 400 invalid_grant / 401 unauthorized: the code or refresh token is no longer valid.
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new RevolutAuthError(msg);
    throw new RevolutApiError(msg, res.status);
  }
  const t = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number };
  if (!t.access_token) throw new RevolutApiError("Revolut's token response had no access token.", res.status);
  const now = c.now ?? Date.now();
  return {
    accessToken: t.access_token,
    accessTokenExpiresAt: new Date(now + (t.expires_in ?? 2399) * 1000),
    refreshToken: t.refresh_token,
    refreshTokenExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000) : null,
  };
}

/** Exchanges the code from the consent redirect for access and refresh tokens. */
export function exchangeCode(code: string, c: Creds): Promise<TokenSet> {
  return tokenRequest({ grant_type: "authorization_code", code }, c);
}

/** A new access token from the refresh token. Throws RevolutAuthError when the refresh token is dead. */
export function refreshAccessToken(refreshToken: string, c: Creds): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, c);
}

async function get<T>(path: string, accessToken: string, opts: { fetch?: FetchLike; env?: Env } = {}): Promise<T> {
  const res = await (opts.fetch ?? fetch)(`${revolutUrls(opts.env).api}${path}`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (res.status === 401) throw new RevolutApiError(await describe(res), 401);
  if (!res.ok) throw new RevolutApiError(await describe(res), res.status);
  return (await res.json()) as T;
}

export interface RevolutAccount {
  id: string;
  name: string;
  balance?: number;
  currency: string;
  state?: string;
}

export interface RevolutLeg {
  leg_id?: string;
  account_id: string;
  counterparty?: { id?: string; account_id?: string; account_type?: "self" | "revolut" | "external" | string };
  amount: number;
  fee?: number;
  currency: string;
  bill_amount?: number;
  bill_currency?: string;
  description?: string;
  balance?: number;
}

export interface RevolutTransaction {
  id: string;
  type: string;
  state: string;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  reference?: string;
  request_id?: string;
  legs: RevolutLeg[];
  merchant?: { name?: string; city?: string; category_code?: string; country?: string };
  card?: { card_number?: string; first_name?: string; last_name?: string };
}

export function getAccounts(accessToken: string, opts: { fetch?: FetchLike; env?: Env } = {}) {
  return get<RevolutAccount[]>("/accounts", accessToken, opts);
}

/** One page of transactions, newest first. from/to are ISO dates or date-times; count is at most 1000. */
export function getTransactions(accessToken: string, q: { from?: string; to?: string; count?: number }, opts: { fetch?: FetchLike; env?: Env } = {}) {
  const p = new URLSearchParams();
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  p.set("count", String(Math.min(q.count ?? 1000, 1000)));
  return get<RevolutTransaction[]>(`/transactions?${p}`, accessToken, opts);
}

/** The OAuth redirect URI registered in Revolut: REVOLUT_REDIRECT_URI, else this site's /api/revolut/callback. */
export function redirectUriFor(origin: string, env: Env = process.env): string {
  return env.REVOLUT_REDIRECT_URI?.trim() || `${origin.replace(/\/$/, "")}/api/revolut/callback`;
}
