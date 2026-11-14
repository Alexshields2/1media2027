// Connecting 1Media's apps to Composio from inside the app (Integrations page).
// Uses Composio's REST API directly: the SDK's toolkits.authorize() relies on an endpoint
// Composio no longer supports for managed OAuth, so login links come from /connected_accounts/link.
import { config } from "../config";

const BASE = "https://backend.composio.dev/api/v3";

export type AppDef = { slug: string; name: string; use: string; group: "Google" | "Ads & CRM" | "Money" | "Messaging"; manual?: string };

/** The apps the agents use, in the order shown on the Integrations page. */
export const APPS: AppDef[] = [
  { slug: "gmail", name: "Gmail", use: "Sort the inbox by client, draft replies and payment chasers", group: "Google" },
  { slug: "googlecalendar", name: "Google Calendar", use: "Call prep before every client call", group: "Google" },
  { slug: "googledrive", name: "Google Drive", use: "Client folders and month-end PDFs", group: "Google" },
  { slug: "googlesheets", name: "Google Sheets", use: "Client tracker sheets", group: "Google" },
  { slug: "googledocs", name: "Google Docs", use: "Reports and briefs", group: "Google" },
  { slug: "facebook", name: "Facebook", use: "Pages, lead forms and ad accounts", group: "Ads & CRM" },
  {
    slug: "metaads",
    name: "Meta Ads",
    use: "Spend, leads, CPL and creative performance",
    group: "Ads & CRM",
    manual: "Composio has no ready-made login for Meta Ads: it needs your own Meta developer app. Ask the CTO chat to set it up.",
  },
  {
    slug: "highlevel",
    name: "GoHighLevel",
    use: "Contacts, pipelines and whether leads get called",
    group: "Ads & CRM",
    manual: "GoHighLevel connects with a Private Integration token (GHL → Settings → Private Integrations). Ask the CTO chat for the secure form.",
  },
  { slug: "stripe", name: "Stripe", use: "Invoices and payment status", group: "Money" },
  { slug: "slack", name: "Slack", use: "Post summaries, alerts and approvals", group: "Messaging" },
  { slug: "whatsapp", name: "WhatsApp", use: "New-lead alerts and client nudges", group: "Messaging" },
];

export type AppStatus = "connected" | "pending" | "failed" | "not_connected";
export type AppState = AppDef & { status: AppStatus; accountId?: string };

export class ComposioError extends Error {}

export function composioReady(): boolean {
  return !!process.env.COMPOSIO_API_KEY?.trim();
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (!key) throw new ComposioError("COMPOSIO_API_KEY isn't set in Vercel yet.");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-api-key": key, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new ComposioError(body?.error?.message ?? `Composio returned ${res.status}`);
  return body;
}

type Account = { id: string; status: string; toolkit?: { slug?: string }; created_at?: string };

const STATUS: Record<string, AppStatus> = { ACTIVE: "connected", INITIALIZING: "pending", INITIATED: "pending", FAILED: "failed", EXPIRED: "failed", INACTIVE: "failed" };

/** Every app with its current connection for the 1Media Composio user. Best status wins (connected > pending > failed). */
export async function appStates(): Promise<AppState[]> {
  const rank: Record<AppStatus, number> = { connected: 3, pending: 2, failed: 1, not_connected: 0 };
  const { items } = await call<{ items: Account[] }>(`/connected_accounts?limit=100&user_ids=${encodeURIComponent(config.composioUserId)}`);
  const best = new Map<string, { status: AppStatus; id: string }>();
  for (const a of items) {
    const slug = a.toolkit?.slug?.toLowerCase();
    if (!slug) continue;
    const status = STATUS[a.status] ?? "failed";
    const cur = best.get(slug);
    if (!cur || rank[status] > rank[cur.status]) best.set(slug, { status, id: a.id });
  }
  return APPS.map((app) => ({ ...app, status: best.get(app.slug)?.status ?? "not_connected", accountId: best.get(app.slug)?.id }));
}

/** The Composio auth config for an app, creating a Composio-managed one when the project has none yet. */
async function authConfigId(slug: string): Promise<string> {
  const { items } = await call<{ items: { id: string; status?: string; toolkit?: { slug?: string } }[] }>(`/auth_configs?limit=100&toolkit_slug=${encodeURIComponent(slug)}`);
  const found = items.find((c) => c.toolkit?.slug?.toLowerCase() === slug && c.status !== "DISABLED");
  if (found) return found.id;
  const created = await call<{ auth_config?: { id: string } }>(`/auth_configs`, {
    method: "POST",
    body: JSON.stringify({ toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } }),
  });
  if (!created.auth_config?.id) throw new ComposioError(`Composio couldn't set up ${slug}.`);
  return created.auth_config.id;
}

/** A one-time login link for an app; after signing in, Composio sends the person back to `callbackUrl`. */
export async function loginLink(slug: string, callbackUrl: string): Promise<string> {
  const app = APPS.find((a) => a.slug === slug);
  if (!app) throw new ComposioError("Unknown app.");
  if (app.manual) throw new ComposioError(app.manual);
  const auth_config_id = await authConfigId(slug);
  const r = await call<{ redirect_url?: string }>(`/connected_accounts/link`, {
    method: "POST",
    body: JSON.stringify({ auth_config_id, user_id: config.composioUserId, callback_url: callbackUrl }),
  });
  if (!r.redirect_url) throw new ComposioError("Composio didn't return a login link.");
  return r.redirect_url;
}

/** Removes a connection (the app's own login is revoked in Composio). */
export async function disconnect(accountId: string): Promise<void> {
  await call(`/connected_accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
}
