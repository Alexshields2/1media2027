import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read-only access to the old Notion OS.
// The only request this module can make is "query a data source" (POST /v1/data_sources/:id/query),
// which reads rows. There is no code path that creates, updates or deletes anything in Notion.

export const NOTION_VERSION = "2025-09-03";

export type SourceKey = "portals" | "monthly" | "crm" | "payments";

export interface NotionPage {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, NotionProp>;
}

// Notion property values are a tagged union; we only read a handful of shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NotionProp = { type: string; [k: string]: any };

export interface SourceDef {
  key: SourceKey;
  title: string;
  envVar: string;
  defaultId: string;
  fixture: string;
  /** Required sources stop the import when unreadable; optional ones are reported and skipped. */
  required: boolean;
}

export const SOURCES: SourceDef[] = [
  { key: "portals", title: "Client Portals", envVar: "NOTION_CLIENTS_DS", defaultId: "f0598ec7-8dd1-8365-bc03-877e4a61c759", fixture: "client-portals.json", required: true },
  { key: "monthly", title: "Client Data Base For Monthly Reports", envVar: "NOTION_MONTHLY_DS", defaultId: "51b99f9e-6c93-4e48-8208-2f7b8de6752d", fixture: "monthly-reports.json", required: false },
  { key: "crm", title: "Sales CRM", envVar: "NOTION_CRM_DS", defaultId: "0ff98ec7-8dd1-83d9-b1fc-074d3d9d0316", fixture: "sales-crm.json", required: false },
  { key: "payments", title: "Payment Collection", envVar: "NOTION_PAYMENTS_DS", defaultId: "1596ffdf-32f4-441c-b673-6bb8dd6c43af", fixture: "payment-collection.json", required: true },
];

export type Env = Record<string, string | undefined>;

export function sourceId(s: SourceDef, env: Env = process.env): string {
  return env[s.envVar] || s.defaultId;
}

type QueryResponse = { results: NotionPage[]; has_more: boolean; next_cursor: string | null };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>;

const QUERY_URL = /^https:\/\/api\.notion\.com\/v1\/data_sources\/[0-9a-f-]{32,36}\/query$/;

export class NotionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Reads every row of a data source, following pagination. Retries politely on rate limits. */
export async function queryAll(dataSourceId: string, opts: { token: string; fetch?: FetchLike; sleep?: (ms: number) => Promise<void> }): Promise<NotionPage[]> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `https://api.notion.com/v1/data_sources/${dataSourceId}/query`;
  if (!QUERY_URL.test(url)) throw new Error(`Refusing to call Notion with an unexpected data source id: ${dataSourceId}`);

  const out: NotionPage[] = [];
  let cursor: string | undefined;
  let attempts = 0;
  for (;;) {
    const res = await doFetch(url, {
      method: "POST", // Notion's query endpoint is a read, despite the verb.
      headers: { Authorization: `Bearer ${opts.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (++attempts > 5) throw new NotionError(`Notion ${res.status} after 5 retries`, res.status);
      const wait = Number(res.headers?.get("retry-after") ?? "") || 2 ** attempts;
      await sleep(wait * 1000);
      continue;
    }
    attempts = 0;
    if (!res.ok) throw new NotionError(`Notion ${res.status}: ${await res.text()}`, res.status);
    const json = (await res.json()) as QueryResponse;
    out.push(...json.results);
    if (!json.has_more || !json.next_cursor) return out;
    cursor = json.next_cursor;
  }
}

/**
 * A fetch stand-in that serves recorded Notion query responses from a folder.
 * Each fixture file is an array of query responses (one per page of results), so pagination is exercised too.
 */
export function fixtureFetch(dir: string, env: Env = process.env): FetchLike {
  const byId = new Map(SOURCES.map((s) => [sourceId(s, env), s]));
  return async (url, init) => {
    const id = url.match(/data_sources\/([^/]+)\/query$/)?.[1] ?? "";
    const src = byId.get(id);
    const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => `{"object":"error","status":404,"code":"object_not_found","message":"Could not find data source with ID: ${id}."}` };
    if (!src) return notFound;
    let pages: QueryResponse[];
    try {
      pages = JSON.parse(readFileSync(join(dir, src.fixture), "utf8"));
    } catch {
      return notFound;
    }
    const cursor = (JSON.parse(init.body) as { start_cursor?: string }).start_cursor;
    const idx = cursor ? pages.findIndex((_, i) => i > 0 && pages[i - 1].next_cursor === cursor) : 0;
    if (idx < 0) return { ok: false, status: 400, json: async () => ({}), text: async () => `bad cursor ${cursor}` };
    const body = pages[idx];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

// ---------- property readers ----------

const joinText = (arr: unknown): string | null => {
  if (!Array.isArray(arr)) return null;
  const s = arr.map((t: { plain_text?: string }) => t.plain_text ?? "").join("").trim();
  return s || null;
};

export function text(p: NotionProp | undefined): string | null {
  if (!p) return null;
  switch (p.type) {
    case "title":
      return joinText(p.title);
    case "rich_text":
      return joinText(p.rich_text);
    case "email":
      return p.email?.trim() || null;
    case "url":
      return p.url?.trim() || null;
    case "phone_number":
      return p.phone_number?.trim() || null;
    case "select":
      return p.select?.name ?? null;
    case "status":
      return p.status?.name ?? null;
    case "number":
      return p.number === null || p.number === undefined ? null : String(p.number);
    default:
      return null;
  }
}

export const num = (p: NotionProp | undefined): number | null => (p?.type === "number" && typeof p.number === "number" ? p.number : null);
export const date = (p: NotionProp | undefined): string | null => (p?.type === "date" ? (p.date?.start?.slice(0, 10) ?? null) : null);
export const select = (p: NotionProp | undefined): string | null => (p?.type === "select" ? (p.select?.name ?? null) : p?.type === "status" ? (p.status?.name ?? null) : null);
export const multi = (p: NotionProp | undefined): string[] => (p?.type === "multi_select" ? (p.multi_select ?? []).map((s: { name: string }) => s.name) : []);
export const checkbox = (p: NotionProp | undefined): boolean | null => (p?.type === "checkbox" ? Boolean(p.checkbox) : null);
export const relationIds = (p: NotionProp | undefined): string[] => (p?.type === "relation" ? (p.relation ?? []).map((r: { id: string }) => r.id) : []);

/** True when a property holds no value a person typed in. Computed properties count as empty. */
export function isEmpty(p: NotionProp | undefined): boolean {
  if (!p) return true;
  switch (p.type) {
    case "title":
    case "rich_text":
    case "email":
    case "url":
    case "phone_number":
    case "select":
    case "status":
      return text(p) === null;
    case "number":
      return num(p) === null;
    case "date":
      return date(p) === null;
    case "multi_select":
      return multi(p).length === 0;
    case "checkbox":
      return !p.checkbox;
    case "relation":
      return relationIds(p).length === 0;
    case "people":
      return !(p.people ?? []).length;
    case "files":
      return !(p.files ?? []).length;
    default:
      return true; // formula, rollup, button, created_time, unique_id...
  }
}
