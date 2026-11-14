// File storage on Supabase Storage, through its REST API (no SDK needed).
//
// The bytes live in one private bucket; file and folder names, nesting and client links live in
// Postgres (schema.files / schema.fileFolders). Browsers upload straight to Supabase with a
// one-time signed URL, so big files never pass through a Vercel function (4.5 MB body limit),
// and downloads are short-lived signed links. Nothing in the bucket is ever public.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only). SUPABASE_STORAGE_BUCKET is optional.

import { randomUUID } from "node:crypto";

type Env = Record<string, string | undefined>;

export function storageConfig(env: Env = process.env) {
  const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "";
  const bucket = env.SUPABASE_STORAGE_BUCKET || "1media-files";
  return { url, key, bucket, enabled: !!url && !!key };
}

export const storageEnabled = () => storageConfig().enabled;

/** Biggest single upload we hand out a link for (Supabase's own per-file limit still applies). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const PATH_RE = /^uploads\/\d{4}-\d{2}\/[0-9a-f-]{36}\/[^/]{1,200}$/;

/** A name safe to use as the last part of an object key. The real name is kept in the database. */
export function safeObjectName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-120);
  return cleaned || "file";
}

/** A fresh, unguessable object key: uploads/2026-11/<uuid>/<name>. */
export function newObjectPath(name: string, now = new Date()): string {
  const month = now.toISOString().slice(0, 7);
  return `uploads/${month}/${randomUUID()}/${safeObjectName(name)}`;
}

export const isObjectPath = (p: string) => PATH_RE.test(p);

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { url, key, enabled } = storageConfig();
  if (!enabled) throw new Error("File storage isn't set up: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const { json, ...rest } = init;
  return fetch(`${url}/storage/v1${path}`, {
    ...rest,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new Error(`Supabase Storage couldn't ${what} (${res.status}): ${text.slice(0, 300)}`);
}

let bucketReady: Promise<void> | null = null;

/** Creates the private bucket the first time it's needed. Safe to call often. */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const { bucket } = storageConfig();
    const got = await call(`/bucket/${encodeURIComponent(bucket)}`);
    if (got.ok) return;
    const made = await call("/bucket", { method: "POST", json: { id: bucket, name: bucket, public: false } });
    // 409 / "already exists": someone else created it in the meantime.
    if (!made.ok && made.status !== 409 && !/already exists/i.test(await made.clone().text())) await fail(made, "create the bucket");
  })().catch((e) => {
    bucketReady = null;
    throw e;
  });
  return bucketReady;
}

/** A one-time URL the browser can PUT the file to (valid for 2 hours). */
export async function createUploadUrl(path: string): Promise<string> {
  await ensureBucket();
  const { url, bucket } = storageConfig();
  const sign = () => call(`/object/upload/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, { method: "POST", json: {} });
  let res = await sign();
  if (res.status === 404 || (res.status === 400 && /bucket/i.test(await res.clone().text()))) {
    // The bucket was deleted since we last checked: make it again, once.
    bucketReady = null;
    await ensureBucket();
    res = await sign();
  }
  if (!res.ok) await fail(res, "create an upload link");
  const body = (await res.json()) as { url?: string; token?: string };
  if (!body.url) throw new Error("Supabase Storage didn't return an upload link.");
  return `${url}/storage/v1${body.url}`;
}

/** Size and type of an uploaded object, or null if it isn't there. */
export async function objectInfo(path: string): Promise<{ size: number; mimeType: string | null } | null> {
  const { bucket } = storageConfig();
  const res = await call(`/object/info/${encodeURIComponent(bucket)}/${encodePath(path)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) await fail(res, "read the file");
  const body = (await res.json()) as { size?: number; content_type?: string; metadata?: { size?: number; mimetype?: string } };
  return { size: Number(body.size ?? body.metadata?.size ?? 0), mimeType: body.content_type ?? body.metadata?.mimetype ?? null };
}

/** A short-lived link to the file. With downloadAs, the browser saves it under that name. */
export async function createDownloadUrl(path: string, opts: { downloadAs?: string; expiresIn?: number } = {}): Promise<string> {
  const { url, bucket } = storageConfig();
  const res = await call(`/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
    method: "POST",
    json: { expiresIn: opts.expiresIn ?? 300 },
  });
  if (!res.ok) await fail(res, "create a download link");
  const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) throw new Error("Supabase Storage didn't return a download link.");
  const link = new URL(`${url}/storage/v1${signed}`);
  if (opts.downloadAs) link.searchParams.set("download", opts.downloadAs);
  return link.toString();
}

/** Deletes objects (in batches of 1000). Missing objects are ignored. */
export async function removeObjects(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { bucket } = storageConfig();
  for (let i = 0; i < paths.length; i += 1000) {
    const res = await call(`/object/${encodeURIComponent(bucket)}`, { method: "DELETE", json: { prefixes: paths.slice(i, i + 1000) } });
    if (!res.ok) await fail(res, "delete files");
  }
}
