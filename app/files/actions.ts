"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requestMeta, requireSignedIn } from "@/lib/session";
import { audit } from "@/lib/audit";
import { allFolders, canMoveFolder, cleanName, deleteFiles, deleteFolder, inheritedClient, syncClientBelow } from "@/lib/files";
import { MAX_UPLOAD_BYTES, createUploadUrl, isObjectPath, newObjectPath, objectInfo, storageEnabled } from "@/lib/storage";

// Anyone signed in (owner or team) can use Files. Every change is in the audit log.

type Result = { error?: string };

const folderIdFrom = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "" || v === "root") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Unknown folder.");
  return n;
};

async function folderExists(id: number | null) {
  if (id === null) return true;
  const [f] = await db.select({ id: schema.fileFolders.id }).from(schema.fileFolders).where(eq(schema.fileFolders.id, id));
  return !!f;
}

const done = () => revalidatePath("/files", "layout");

async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    return { error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

// ---------- folders ----------

export async function createFolder(_: unknown, form: FormData): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const parentId = folderIdFrom(form.get("parentId"));
    const name = cleanName(form.get("name"), "Folder name");
    if (!(await folderExists(parentId))) throw new Error("That folder no longer exists.");
    const [f] = await db.insert(schema.fileFolders).values({ name, parentId, createdBy: user.id }).returning({ id: schema.fileFolders.id });
    await audit("folder.create", { userId: user.id, target: `folder:${f.id}`, detail: { name, parentId }, ip: (await requestMeta()).ip });
    done();
    return {};
  });
}

export async function renameFolder(id: number, _: unknown, form: FormData): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const name = cleanName(form.get("name"), "Folder name");
    await db.update(schema.fileFolders).set({ name }).where(eq(schema.fileFolders.id, id));
    await audit("folder.rename", { userId: user.id, target: `folder:${id}`, detail: { name } });
    done();
    return {};
  });
}

export async function moveFolder(id: number, _: unknown, form: FormData): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const target = folderIdFrom(form.get("target"));
    const folders = await allFolders();
    if (!folders.some((f) => f.id === id)) throw new Error("That folder no longer exists.");
    if (target !== null && !folders.some((f) => f.id === target)) throw new Error("The destination folder no longer exists.");
    if (!canMoveFolder(folders, id, target)) throw new Error("A folder can't go inside itself.");
    await db.update(schema.fileFolders).set({ parentId: target }).where(eq(schema.fileFolders.id, id));
    await syncClientBelow(id);
    await audit("folder.move", { userId: user.id, target: `folder:${id}`, detail: { to: target } });
    done();
    return {};
  });
}

export async function removeFolder(id: number): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const [f] = await db.select().from(schema.fileFolders).where(eq(schema.fileFolders.id, id));
    if (!f) return {};
    const n = await deleteFolder(id);
    await audit("folder.delete", { userId: user.id, target: `folder:${id}`, detail: { name: f.name, files: n }, ip: (await requestMeta()).ip });
    done();
    return {};
  });
}

// ---------- files ----------

/** Step 1 of an upload: a one-time link the browser PUTs the file to, straight into Supabase. */
export async function startUpload(input: { folderId: number | null; name: string; size: number }): Promise<{ path: string; uploadUrl: string; error?: undefined } | { error: string }> {
  return guard(async () => {
    await requireSignedIn();
    if (!storageEnabled()) throw new Error("File storage isn't set up yet: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.");
    const name = cleanName(input.name, "File name");
    if (!(input.size >= 0) || input.size > MAX_UPLOAD_BYTES) throw new Error(`${name} is too big.`);
    if (!(await folderExists(folderIdFrom(input.folderId)))) throw new Error("That folder no longer exists.");
    const path = newObjectPath(name);
    return { path, uploadUrl: await createUploadUrl(path) };
  });
}

/** Step 2: the file is in storage, so record it in the folder. */
export async function finishUpload(input: { folderId: number | null; name: string; path: string; type: string }): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const name = cleanName(input.name, "File name");
    const folderId = folderIdFrom(input.folderId);
    if (!isObjectPath(input.path)) throw new Error("Unknown upload.");
    const info = await objectInfo(input.path);
    if (!info) throw new Error(`${name} didn't finish uploading. Try again.`);
    const clientId = inheritedClient(await allFolders(), folderId);
    const [f] = await db
      .insert(schema.files)
      .values({ name, folderId, clientId, storagePath: input.path, mimeType: info.mimeType || input.type || null, size: info.size, uploadedBy: user.id })
      .onConflictDoNothing()
      .returning({ id: schema.files.id });
    if (f) await audit("file.upload", { userId: user.id, target: `file:${f.id}`, detail: { name, folderId, size: info.size } });
    done();
    return {};
  });
}

export async function renameFile(id: number, _: unknown, form: FormData): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const name = cleanName(form.get("name"), "File name");
    await db.update(schema.files).set({ name }).where(eq(schema.files.id, id));
    await audit("file.rename", { userId: user.id, target: `file:${id}`, detail: { name } });
    done();
    return {};
  });
}

export async function moveFile(id: number, _: unknown, form: FormData): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const target = folderIdFrom(form.get("target"));
    const folders = await allFolders();
    if (target !== null && !folders.some((f) => f.id === target)) throw new Error("The destination folder no longer exists.");
    await db.update(schema.files).set({ folderId: target, clientId: inheritedClient(folders, target) }).where(eq(schema.files.id, id));
    await audit("file.move", { userId: user.id, target: `file:${id}`, detail: { to: target } });
    done();
    return {};
  });
}

export async function removeFile(id: number): Promise<Result> {
  return guard(async () => {
    const user = await requireSignedIn();
    const [f] = await db.select({ name: schema.files.name }).from(schema.files).where(eq(schema.files.id, id));
    if (!f) return {};
    await deleteFiles([id]);
    await audit("file.delete", { userId: user.id, target: `file:${id}`, detail: { name: f.name }, ip: (await requestMeta()).ip });
    done();
    return {};
  });
}
