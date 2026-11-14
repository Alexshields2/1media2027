"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createFolder, finishUpload, moveFile, moveFolder, removeFile, removeFolder, renameFile, renameFolder, startUpload } from "./actions";
import { Icon } from "../_components/icons";
import { btn, btnGhost, field, input } from "../_components/ui";

type Up = { key: string; name: string; progress: number; error?: string; done?: boolean };

function putWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.send(file);
  });
}

/** Upload button plus a drop zone over the whole page. Files go straight to Supabase Storage. */
export function Uploader({ folderId, enabled }: { folderId: number | null; enabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [ups, setUps] = useState<Up[]>([]);
  const [dragging, setDragging] = useState(false);

  const patch = (key: string, p: Partial<Up>) => setUps((all) => all.map((u) => (u.key === key ? { ...u, ...p } : u)));

  async function upload(list: FileList | File[]) {
    const files = Array.from(list);
    if (!files.length) return;
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, progress: 0 }));
    setUps((all) => [...all.filter((u) => !u.done), ...batch]);
    // Three at a time.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const file = files[i];
        const { key } = batch[i];
        try {
          const start = await startUpload({ folderId, name: file.name, size: file.size });
          if (start.error !== undefined) throw new Error(start.error);
          await putWithProgress(start.uploadUrl, file, (p) => patch(key, { progress: p }));
          const fin = await finishUpload({ folderId, name: file.name, path: start.path, type: file.type });
          if (fin.error) throw new Error(fin.error);
          patch(key, { progress: 1, done: true });
        } catch (e) {
          patch(key, { error: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    router.refresh();
  }

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) upload(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, folderId]);

  const active = ups.filter((u) => !u.done || u.error);
  const finished = ups.filter((u) => u.done && !u.error).length;

  return (
    <>
      <button type="button" className={btn} disabled={!enabled} onClick={() => inputRef.current?.click()} title={enabled ? "Upload files (or drag them onto the page)" : "File storage isn't set up yet"}>
        <Icon name="upload" className="size-4" /> Upload
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) upload(e.target.files);
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-canvas/70 backdrop-blur-sm">
          <div className="rounded-3xl border-2 border-dashed border-brand bg-panel px-10 py-8 text-center shadow-[0_0_60px_rgb(4_153_242/0.25)]">
            <Icon name="upload" className="mx-auto size-8 text-brand-light" />
            <p className="mt-2 font-medium">Drop to upload here</p>
          </div>
        </div>
      )}
      {ups.length > 0 && (
        <div className="fixed right-4 bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-panel p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between text-sm font-medium">
            <span>{active.some((u) => !u.error) ? `Uploading ${active.filter((u) => !u.error).length}…` : `${finished} uploaded`}</span>
            {!active.some((u) => !u.error && !u.done) && (
              <button type="button" className="text-xs text-ink/50 hover:text-ink" onClick={() => setUps([])}>
                Close
              </button>
            )}
          </div>
          <ul className="max-h-60 space-y-2 overflow-y-auto">
            {ups.map((u) => (
              <li key={u.key} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{u.name}</span>
                  <span className={u.error ? "text-red-300" : u.done ? "text-emerald-300" : "text-ink/50"}>{u.error ? "Failed" : u.done ? "Done" : `${Math.round(u.progress * 100)}%`}</span>
                </div>
                {u.error ? (
                  <p className="mt-0.5 text-red-300/80">{u.error}</p>
                ) : (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink/10">
                    <div className={`h-full rounded-full ${u.done ? "bg-emerald-400" : "brand-gradient"}`} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Popover({ trigger, children, align = "right" }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className={`absolute top-full z-30 mt-2 w-72 rounded-xl border border-line bg-panel p-3 shadow-2xl ${align === "right" ? "right-0" : "left-0"}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

type Act = (prev: unknown, form: FormData) => Promise<{ error?: string }>;

function ActionForm({ action, onDone, children }: { action: Act; onDone: () => void; children: (pending: boolean) => ReactNode }) {
  const [state, run, pending] = useActionState(async (prev: unknown, form: FormData) => {
    const res = await action(prev, form);
    if (!res.error) onDone();
    return res;
  }, {} as { error?: string });
  return (
    <form action={run} className="space-y-2">
      {children(pending)}
      {state.error && <p className="text-xs text-red-300">{state.error}</p>}
    </form>
  );
}

export function NewFolderButton({ parentId }: { parentId: number | null }) {
  return (
    <Popover
      trigger={
        <button type="button" className={btnGhost}>
          <Icon name="plus" className="mr-1.5 size-4" /> New folder
        </button>
      }
    >
      {(close) => (
        <ActionForm action={createFolder} onDone={close}>
          {(pending) => (
            <>
              <input type="hidden" name="parentId" value={parentId ?? ""} />
              <input name="name" required autoFocus placeholder="Folder name" className={input} />
              <button className={`${btn} w-full`} disabled={pending}>
                {pending ? "Creating…" : "Create folder"}
              </button>
            </>
          )}
        </ActionForm>
      )}
    </Popover>
  );
}

type Dest = { id: number; path: string };

/** The ⋯ menu on a file or folder: rename, move, delete. */
export function ItemMenu({ kind, id, name, destinations, currentFolder }: { kind: "file" | "folder"; id: number; name: string; destinations: Dest[]; currentFolder: number | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<"menu" | "rename" | "move">("menu");
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string>();
  const rename = (kind === "file" ? renameFile : renameFolder).bind(null, id) as Act;
  const move = (kind === "file" ? moveFile : moveFolder).bind(null, id) as Act;
  const options = destinations.filter((d) => d.id !== currentFolder);

  return (
    <Popover
      trigger={
        <button type="button" aria-label={`Actions for ${name}`} className="grid size-8 place-items-center rounded-full text-ink/50 hover:bg-ink/[0.06] hover:text-ink" onClick={() => { setMode("menu"); setErr(undefined); }}>
          <Icon name="dots" className="size-4" />
        </button>
      }
    >
      {(close) =>
        mode === "rename" ? (
          <ActionForm action={rename} onDone={close}>
            {(pending) => (
              <>
                <input name="name" required autoFocus defaultValue={name} className={input} onFocus={(e) => {
                  const dot = kind === "file" ? e.target.value.lastIndexOf(".") : -1;
                  e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                }} />
                <button className={`${btn} w-full`} disabled={pending}>{pending ? "Saving…" : "Rename"}</button>
              </>
            )}
          </ActionForm>
        ) : mode === "move" ? (
          <ActionForm action={move} onDone={close}>
            {(pending) => (
              <>
                <label className="block text-xs text-ink/60">Move “{name}” to</label>
                <select name="target" className={`${field} w-full`} defaultValue={currentFolder === null ? "" : "root"}>
                  {currentFolder !== null && <option value="root">Files (top level)</option>}
                  {options.map((d) => (
                    <option key={d.id} value={d.id}>{d.path}</option>
                  ))}
                </select>
                <button className={`${btn} w-full`} disabled={pending || (currentFolder === null && !options.length)}>{pending ? "Moving…" : "Move"}</button>
              </>
            )}
          </ActionForm>
        ) : (
          <div className="-m-1 flex flex-col text-sm">
            <button type="button" className="rounded-lg px-3 py-2 text-left hover:bg-ink/[0.05]" onClick={() => setMode("rename")}>Rename</button>
            <button type="button" className="rounded-lg px-3 py-2 text-left hover:bg-ink/[0.05]" onClick={() => setMode("move")}>Move to…</button>
            <button
              type="button"
              disabled={deleting}
              className="rounded-lg px-3 py-2 text-left text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              onClick={async () => {
                const msg = kind === "folder" ? `Delete the folder “${name}” and everything in it? This can't be undone.` : `Delete “${name}”? This can't be undone.`;
                if (!confirm(msg)) return;
                setDeleting(true);
                const res = await (kind === "file" ? removeFile(id) : removeFolder(id));
                setDeleting(false);
                if (res.error) return setErr(res.error);
                close();
                router.refresh();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
            {err && <p className="px-3 pb-1 text-xs text-red-300">{err}</p>}
          </div>
        )
      }
    </Popover>
  );
}
