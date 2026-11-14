import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbs, canMoveFolder, cleanName, descendantIds, fileKind, folderPaths, formatBytes, inheritedClient, previewable, type FolderNode } from "../src/lib/files";
import { isObjectPath, newObjectPath, safeObjectName, storageConfig } from "../src/lib/storage";

const F = (id: number, name: string, parentId: number | null, clientId: number | null = null): FolderNode => ({ id, name, parentId, clientId });
const tree = [F(1, "Clients", null), F(2, "Apex Attics", 1, 7), F(3, "Creatives", 2), F(4, "Q1", 3), F(5, "Internal", null)];

test("breadcrumbs go root-first and survive loops", () => {
  assert.deepEqual(breadcrumbs(tree, 4).map((f) => f.name), ["Clients", "Apex Attics", "Creatives", "Q1"]);
  assert.deepEqual(breadcrumbs(tree, null), []);
  assert.deepEqual(breadcrumbs([F(1, "a", 2), F(2, "b", 1)], 1).map((f) => f.id), [2, 1]);
});

test("descendants and moves", () => {
  assert.deepEqual(descendantIds(tree, 2).sort(), [2, 3, 4]);
  assert.equal(canMoveFolder(tree, 2, 4), false, "not into its own child");
  assert.equal(canMoveFolder(tree, 2, 2), false, "not into itself");
  assert.equal(canMoveFolder(tree, 2, 5), true);
  assert.equal(canMoveFolder(tree, 2, null), true);
});

test("files inherit the nearest folder's client", () => {
  assert.equal(inheritedClient(tree, 4), 7);
  assert.equal(inheritedClient(tree, 5), null);
  assert.equal(inheritedClient(tree, null), null);
});

test("folder paths for the move picker", () => {
  assert.deepEqual(folderPaths(tree).map((p) => p.path), ["Clients", "Clients / Apex Attics", "Clients / Apex Attics / Creatives", "Clients / Apex Attics / Creatives / Q1", "Internal"]);
});

test("names are cleaned", () => {
  assert.equal(cleanName("  Q1  reports/final "), "Q1 reports final");
  assert.throws(() => cleanName("   "));
  assert.throws(() => cleanName(".."));
  assert.throws(() => cleanName("x".repeat(201)));
});

test("object paths are unguessable and validated", () => {
  const p = newObjectPath("Brand guide (v2).pdf", new Date("2026-11-14T10:00:00Z"));
  assert.match(p, /^uploads\/2026-11\/[0-9a-f-]{36}\/Brand-guide-v2.pdf$/);
  assert.ok(isObjectPath(p));
  assert.equal(isObjectPath("uploads/2026-11/../../etc/passwd"), false);
  assert.equal(isObjectPath("other/2026-11/x/y"), false);
  assert.equal(safeObjectName("..."), "file");
  assert.equal(safeObjectName("Café menu.jpg"), "Cafe-menu.jpg");
});

test("storage config", () => {
  assert.equal(storageConfig({}).enabled, false);
  const c = storageConfig({ SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.deepEqual(c, { url: "https://abc.supabase.co", key: "k", bucket: "1media-files", enabled: true });
});

test("kinds, previews and sizes", () => {
  assert.equal(fileKind("ad.MP4", null), "video");
  assert.equal(fileKind("leads.csv", "text/csv"), "sheet");
  assert.equal(fileKind("contract.pdf", null), "pdf");
  assert.equal(previewable("logo.svg", "image/svg+xml"), false);
  assert.equal(previewable("photo.jpg", "image/jpeg"), true);
  assert.equal(previewable("page.html", "text/html"), false);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(25 * 1024 * 1024), "25 MB");
});
