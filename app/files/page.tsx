import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, ilike, inArray, isNull, sum } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";
import { allFolders, breadcrumbs, descendantIds, fileKind, folderPaths, formatBytes, previewable, type FileKind } from "@/lib/files";
import { storageEnabled } from "@/lib/storage";
import { Badge, Card, Empty, PageHeader } from "../_components/ui";
import { Icon, type IconName } from "../_components/icons";
import { ItemMenu, NewFolderButton, Uploader } from "./files-ui";

export const dynamic = "force-dynamic";

const KIND_ICON: Record<FileKind, { icon: IconName; color: string }> = {
  folder: { icon: "folder", color: "text-brand-light" },
  image: { icon: "image", color: "text-fuchsia-300" },
  video: { icon: "film", color: "text-rose-300" },
  audio: { icon: "music", color: "text-violet-300" },
  pdf: { icon: "doc", color: "text-red-300" },
  sheet: { icon: "table", color: "text-emerald-300" },
  slides: { icon: "chart", color: "text-amber-300" },
  doc: { icon: "doc", color: "text-sky-300" },
  archive: { icon: "archive", color: "text-ink/60" },
  file: { icon: "file", color: "text-ink/60" },
};

const when = (d: Date) => d.toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", year: "numeric" });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ folder?: string; q?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const folderId = sp.folder ? Number(sp.folder) : null;
  if (folderId !== null && !Number.isInteger(folderId)) notFound();

  const folders = await allFolders();
  if (folderId !== null && !folders.some((f) => f.id === folderId)) notFound();
  const crumbs = breadcrumbs(folders, folderId);
  const here = crumbs.at(-1);
  const paths = folderPaths(folders);
  const pathOf = new Map(paths.map((p) => [p.id, p.path]));

  const fileCols = {
    f: schema.files,
    uploader: schema.users.name,
    client: schema.clients.name,
  };
  const [subfolders, fileRows, usage, clients] = await Promise.all([
    q
      ? db.select().from(schema.fileFolders).where(ilike(schema.fileFolders.name, `%${escapeLike(q)}%`)).orderBy(schema.fileFolders.name).limit(100)
      : db
          .select()
          .from(schema.fileFolders)
          .where(folderId === null ? isNull(schema.fileFolders.parentId) : eq(schema.fileFolders.parentId, folderId))
          .orderBy(schema.fileFolders.name),
    db
      .select(fileCols)
      .from(schema.files)
      .leftJoin(schema.users, eq(schema.users.id, schema.files.uploadedBy))
      .leftJoin(schema.clients, eq(schema.clients.id, schema.files.clientId))
      .where(q ? ilike(schema.files.name, `%${escapeLike(q)}%`) : folderId === null ? isNull(schema.files.folderId) : eq(schema.files.folderId, folderId))
      .orderBy(q ? desc(schema.files.createdAt) : schema.files.name)
      .limit(500),
    db.select({ n: count(), bytes: sum(schema.files.size) }).from(schema.files),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  // Item counts per visible folder (direct children only).
  const ids = subfolders.map((f) => f.id);
  const [childFolders, childFiles] = ids.length
    ? await Promise.all([
        db.select({ id: schema.fileFolders.parentId, n: count() }).from(schema.fileFolders).where(inArray(schema.fileFolders.parentId, ids)).groupBy(schema.fileFolders.parentId),
        db.select({ id: schema.files.folderId, n: count() }).from(schema.files).where(inArray(schema.files.folderId, ids)).groupBy(schema.files.folderId),
      ])
    : [[], []];
  const items = new Map<number, number>();
  for (const r of [...childFolders, ...childFiles]) if (r.id !== null) items.set(r.id, (items.get(r.id) ?? 0) + r.n);

  const enabled = storageEnabled();
  const totalBytes = Number(usage[0]?.bytes ?? 0);
  const folderClient = here ? (here.clientId ?? crumbs.findLast((c) => c.clientId !== null)?.clientId ?? null) : null;

  return (
    <>
      <PageHeader
        title="Files"
        subtitle={`${usage[0]?.n ?? 0} file${usage[0]?.n === 1 ? "" : "s"} · ${formatBytes(totalBytes)} stored in Supabase`}
        actions={
          <>
            <form className="flex items-center gap-2 rounded-full border border-line bg-panel px-4 py-2">
              <Icon name="search" className="size-4 text-ink/40" />
              <input name="q" defaultValue={q} placeholder="Search all files…" className="w-40 bg-transparent text-sm outline-none placeholder:text-ink/35 sm:w-56" />
            </form>
            {!q && <NewFolderButton parentId={folderId} />}
            {!q && <Uploader folderId={folderId} enabled={enabled} />}
          </>
        }
      />

      {!enabled && (
        <p className="mb-6 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          File storage isn&apos;t connected yet. In Vercel → Settings → Environment Variables add <code className="text-amber-100">SUPABASE_URL</code> and{" "}
          <code className="text-amber-100">SUPABASE_SERVICE_ROLE_KEY</code> (Supabase → Project Settings → API), then redeploy. You can already create folders.
        </p>
      )}

      <nav aria-label="Folder path" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
        {q ? (
          <>
            <Link href={folderId ? `/files?folder=${folderId}` : "/files"} className="text-ink/50 hover:text-ink">← Back</Link>
            <span className="ml-2 text-ink/70">Results for “{q}”</span>
          </>
        ) : (
          <>
            <Link href="/files" className={`rounded-md px-2 py-1 ${crumbs.length ? "text-ink/55 hover:bg-ink/[0.05] hover:text-ink" : "font-medium"}`}>
              Files
            </Link>
            {crumbs.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1">
                <span className="text-ink/25">/</span>
                {i === crumbs.length - 1 ? (
                  <span className="px-2 py-1 font-medium">{c.name}</span>
                ) : (
                  <Link href={`/files?folder=${c.id}`} className="rounded-md px-2 py-1 text-ink/55 hover:bg-ink/[0.05] hover:text-ink">{c.name}</Link>
                )}
              </span>
            ))}
            {folderClient !== null && clientName.has(folderClient) && (
              <Link href={`/clients/${folderClient}`} className="ml-2">
                <Badge tone="brand">{crumbs.at(-1)?.name === clientName.get(folderClient) ? "Client page →" : `Client: ${clientName.get(folderClient)}`}</Badge>
              </Link>
            )}
          </>
        )}
      </nav>

      {subfolders.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink/45 uppercase">Folders</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {subfolders.map((f) => {
              const blocked = new Set(descendantIds(folders, f.id));
              return (
                <div key={f.id} className="group flex items-center gap-3 rounded-xl border border-line bg-panel py-2 pr-1.5 pl-3 transition-colors hover:border-brand/50">
                  <Link href={`/files?folder=${f.id}`} className="flex min-w-0 flex-1 items-center gap-3 py-1">
                    <Icon name="folder" className="size-5 shrink-0 text-brand-light" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{f.name}</span>
                      <span className="block truncate text-xs text-ink/40">
                        {q ? pathOf.get(f.id) : `${items.get(f.id) ?? 0} item${items.get(f.id) === 1 ? "" : "s"}`}
                        {f.clientId !== null && clientName.has(f.clientId) && !q ? ` · ${clientName.get(f.clientId)}` : ""}
                      </span>
                    </span>
                  </Link>
                  <ItemMenu kind="folder" id={f.id} name={f.name} currentFolder={f.parentId} destinations={paths.filter((p) => !blocked.has(p.id))} />
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Card title={q ? "Files" : here ? `In ${here.name}` : "Files at the top level"}>
        {fileRows.length ? (
          <div className="-mx-4">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs tracking-wide text-ink/50 uppercase">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="hidden w-[22%] px-4 py-2 font-medium md:table-cell">{q ? "Folder" : "Client"}</th>
                  <th className="hidden w-48 px-4 py-2 font-medium lg:table-cell">Uploaded</th>
                  <th className="hidden w-24 px-4 py-2 text-right font-medium sm:table-cell">Size</th>
                  <th className="w-20 px-2 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {fileRows.map(({ f, uploader, client }) => {
                  const k = KIND_ICON[fileKind(f.name, f.mimeType)];
                  const open = previewable(f.name, f.mimeType) ? `/files/open/${f.id}?inline=1` : `/files/open/${f.id}`;
                  return (
                    <tr key={f.id} className="hover:bg-ink/[0.02]">
                      <td className="px-4 py-2">
                        <a href={open} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 hover:text-brand-light">
                          <Icon name={k.icon} className={`size-5 shrink-0 ${k.color}`} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium" title={f.name}>{f.name}</span>
                            <span className="block truncate text-xs text-ink/40 sm:hidden">{formatBytes(f.size)} · {when(f.createdAt)}</span>
                          </span>
                        </a>
                      </td>
                      <td className="hidden truncate px-4 py-2 text-ink/60 md:table-cell">
                        {q ? (
                          <Link href={f.folderId ? `/files?folder=${f.folderId}` : "/files"} className="hover:text-ink">
                            {f.folderId ? pathOf.get(f.folderId) : "Files"}
                          </Link>
                        ) : client && f.clientId ? (
                          <Link href={`/clients/${f.clientId}`} className="hover:text-ink">{client}</Link>
                        ) : (
                          <span className="text-ink/30">—</span>
                        )}
                      </td>
                      <td className="hidden truncate px-4 py-2 whitespace-nowrap text-ink/60 lg:table-cell">
                        {when(f.createdAt)}
                        {uploader && <span className="text-ink/35"> · {uploader}</span>}
                      </td>
                      <td className="num hidden px-4 py-2 text-right whitespace-nowrap text-ink/60 sm:table-cell">{formatBytes(f.size)}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center justify-end gap-0.5">
                          <a href={`/files/open/${f.id}`} title="Download" aria-label={`Download ${f.name}`} className="grid size-8 place-items-center rounded-full text-ink/50 hover:bg-ink/[0.06] hover:text-ink">
                            <Icon name="download" className="size-4" />
                          </a>
                          <ItemMenu kind="file" id={f.id} name={f.name} currentFolder={f.folderId} destinations={paths} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {q ? "No files match." : subfolders.length ? "No files in this folder yet, only folders." : enabled ? "Nothing here yet. Upload files or drag them onto the page." : "Nothing here yet."}
          </Empty>
        )}
      </Card>
    </>
  );
}
