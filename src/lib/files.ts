// Folders and files (Drive-style). The database holds names, nesting and client links;
// src/lib/storage.ts holds the bytes. Renaming and moving never touch storage.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import type { FileFolder } from "../db/schema";
import { removeObjects } from "./storage";

export type FolderNode = Pick<FileFolder, "id" | "name" | "parentId" | "clientId">;

/** Trims a file or folder name and rejects ones that would be confusing. */
export function cleanName(raw: unknown, what = "Name"): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f/\\]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!name) throw new Error(`${what} can't be empty.`);
  if (name.length > 200) throw new Error(`${what} is too long (200 characters max).`);
  if (name === "." || name === "..") throw new Error(`${what} can't be "${name}".`);
  return name;
}

export async function allFolders(): Promise<FolderNode[]> {
  return db
    .select({ id: schema.fileFolders.id, name: schema.fileFolders.name, parentId: schema.fileFolders.parentId, clientId: schema.fileFolders.clientId })
    .from(schema.fileFolders);
}

/** Root-first chain of folders down to `id` (empty for the root). Stops on loops. */
export function breadcrumbs(folders: FolderNode[], id: number | null): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: FolderNode[] = [];
  const seen = new Set<number>();
  let cur = id === null ? undefined : byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return chain;
}

/** `id` and every folder inside it, at any depth. */
export function descendantIds(folders: FolderNode[], id: number): number[] {
  const kids = new Map<number, number[]>();
  for (const f of folders) if (f.parentId !== null) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f.id]);
  const out: number[] = [];
  const stack = [id];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** Every folder as "Parent / Child" paths, sorted, for move pickers. */
export function folderPaths(folders: FolderNode[]): { id: number; path: string }[] {
  return folders
    .map((f) => ({ id: f.id, path: breadcrumbs(folders, f.id).map((b) => b.name).join(" / ") }))
    .sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
}

/** The client a folder belongs to: its own, or the nearest parent's. */
export function inheritedClient(folders: FolderNode[], folderId: number | null): number | null {
  const chain = breadcrumbs(folders, folderId);
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].clientId !== null) return chain[i].clientId;
  return null;
}

/** Can `folderId` move into `targetId` (null = root)? Not into itself or anything inside it. */
export function canMoveFolder(folders: FolderNode[], folderId: number, targetId: number | null): boolean {
  if (targetId === null) return true;
  return !descendantIds(folders, folderId).includes(targetId);
}

/** The top-level "Clients" folder, created on first use. */
async function clientsRoot(createdBy: number | null): Promise<number> {
  const [found] = await db
    .select({ id: schema.fileFolders.id })
    .from(schema.fileFolders)
    .where(and(isNull(schema.fileFolders.parentId), isNull(schema.fileFolders.clientId), eq(schema.fileFolders.name, "Clients")))
    .limit(1);
  if (found) return found.id;
  const [made] = await db.insert(schema.fileFolders).values({ name: "Clients", createdBy }).returning({ id: schema.fileFolders.id });
  return made.id;
}

/** The client's own folder (Clients / <name>), created on first use. */
export async function ensureClientFolder(clientId: number, createdBy: number | null): Promise<number> {
  const [existing] = await db
    .select({ id: schema.fileFolders.id, parentId: schema.fileFolders.parentId })
    .from(schema.fileFolders)
    .where(eq(schema.fileFolders.clientId, clientId))
    .orderBy(schema.fileFolders.id);
  if (existing) return existing.id;
  const [client] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new Error("That client doesn't exist.");
  const parentId = await clientsRoot(createdBy);
  const [made] = await db
    .insert(schema.fileFolders)
    .values({ name: client.name, parentId, clientId, createdBy })
    .returning({ id: schema.fileFolders.id });
  return made.id;
}

/** Deletes files: storage first, then the rows. */
export async function deleteFiles(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.select({ id: schema.files.id, path: schema.files.storagePath }).from(schema.files).where(inArray(schema.files.id, ids));
  await removeObjects(rows.map((r) => r.path));
  await db.delete(schema.files).where(inArray(schema.files.id, rows.map((r) => r.id)));
  return rows.length;
}

/** Deletes a folder, everything inside it, and the stored bytes. Returns how many files went. */
export async function deleteFolder(id: number): Promise<number> {
  const ids = descendantIds(await allFolders(), id);
  const rows = await db.select({ id: schema.files.id }).from(schema.files).where(inArray(schema.files.folderId, ids));
  const n = await deleteFiles(rows.map((r) => r.id));
  await db.delete(schema.fileFolders).where(eq(schema.fileFolders.id, id)); // cascades to sub-folders
  return n;
}

/** Points every file and folder inside `id` at the client that folder now belongs to. */
export async function syncClientBelow(id: number): Promise<void> {
  const folders = await allFolders();
  const clientId = inheritedClient(folders, id);
  const ids = descendantIds(folders, id);
  // Sub-folders that are some other client's own folder keep their client.
  const own = new Set(folders.filter((f) => ids.includes(f.id) && f.id !== id && f.clientId !== null && f.clientId !== clientId).flatMap((f) => descendantIds(folders, f.id)));
  const affected = ids.filter((x) => !own.has(x));
  if (!affected.length) return;
  await db.update(schema.files).set({ clientId }).where(inArray(schema.files.folderId, affected));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "sheet" | "doc" | "slides" | "archive" | "file";

export function fileKind(name: string, mime: string | null): FileKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"].includes(ext)) return "image";
  if (m.startsWith("video/") || ["mp4", "mov", "webm", "m4v", "avi"].includes(ext)) return "video";
  if (m.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv", "numbers", "tsv"].includes(ext) || m.includes("spreadsheet") || m === "text/csv") return "sheet";
  if (["ppt", "pptx", "key"].includes(ext) || m.includes("presentation")) return "slides";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || m.includes("zip")) return "archive";
  if (["doc", "docx", "txt", "md", "rtf", "pages", "odt"].includes(ext) || m.startsWith("text/") || m.includes("word")) return "doc";
  return "file";
}

/** Types a browser shows inline safely (no HTML/SVG, which could run script on the storage origin). */
export function previewable(name: string, mime: string | null): boolean {
  const k = fileKind(name, mime);
  if (k === "image") return !(mime ?? "").includes("svg") && !name.toLowerCase().endsWith(".svg");
  return k === "pdf" || k === "video" || k === "audio";
}
