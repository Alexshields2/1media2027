import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { describeSchedule, videoEmbedUrl } from "@/lib/sops";
import { archiveSop, runSopNow, toggleSopDone } from "../../actions";
import { Badge, Card, Empty, btn, btnBrand, btnGhost, input } from "../../_components/ui";
import { SubmitButton } from "../../_components/client-bits";
import { Markdown } from "../../_components/markdown";
import { BreakdownButton, Checklist } from "./bits";

export const dynamic = "force-dynamic";

const LEVEL: Record<string, string> = { L0: "read-only", L1: "drafts everything for approval", L2: "updates the OS, asks before anything external", L3: "full autonomy" };

export default async function SopLesson({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ started?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const me = await requireUser();
  const [sop] = await db.select().from(schema.sops).where(eq(schema.sops.id, Number(id)));
  if (!sop) notFound();

  const [siblings, mine, everyone, runs, clients, users] = await Promise.all([
    db
      .select({ id: schema.sops.id, title: schema.sops.title })
      .from(schema.sops)
      .where(and(eq(schema.sops.category, sop.category), eq(schema.sops.archived, false)))
      .orderBy(asc(schema.sops.position), asc(schema.sops.title)),
    db.select({ sopId: schema.sopProgress.sopId }).from(schema.sopProgress).where(eq(schema.sopProgress.userId, me.id)),
    db.select({ userId: schema.sopProgress.userId, at: schema.sopProgress.completedAt }).from(schema.sopProgress).where(eq(schema.sopProgress.sopId, sop.id)),
    db.select().from(schema.agentRuns).where(eq(schema.agentRuns.sopId, sop.id)).orderBy(desc(schema.agentRuns.startedAt)).limit(10),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.status, ["active", "onboarding"])).orderBy(schema.clients.name),
    allUsers(),
  ]);
  const doneIds = new Set(mine.map((m) => m.sopId));
  const isDone = doneIds.has(sop.id);
  const embed = videoEmbedUrl(sop.videoUrl);
  const owner = users.find((u) => u.id === sop.ownerId);
  const idx = siblings.findIndex((s) => s.id === sop.id);
  const next = siblings[idx + 1];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="min-w-0 space-y-6">
        <div>
          <Link href="/sops" className="text-xs text-black/50 hover:underline">
            SOP library / {sop.category}
          </Link>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{sop.title}</h1>
            <div className="flex gap-2">
              <Link href={`/sops/${sop.id}/edit`} className={btnGhost}>
                Edit
              </Link>
              <form action={archiveSop.bind(null, sop.id, !sop.archived)}>
                <button className={btnGhost}>{sop.archived ? "Restore" : "Archive"}</button>
              </form>
            </div>
          </div>
          {sop.summary && <p className="mt-1 text-black/70">{sop.summary}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {owner && <Badge tone="gray">Owner: {owner.name}</Badge>}
            <Badge tone={sop.agentEnabled ? "brand" : "gray"}>{describeSchedule(sop)}</Badge>
            {sop.archived && <Badge tone="yellow">Archived</Badge>}
          </div>
        </div>

        {sp.started && (
          <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Started {sp.started} run{sp.started === "1" ? "" : "s"}. They appear under Agent runs below; refresh in a minute.
          </div>
        )}

        {embed ? (
          <div className="aspect-video overflow-hidden rounded-xl border border-black/10 bg-black">
            <iframe src={embed} className="size-full" allow="fullscreen; picture-in-picture" allowFullScreen title={sop.title} />
          </div>
        ) : sop.videoUrl ? (
          <a href={sop.videoUrl} target="_blank" rel="noreferrer" className="block rounded-xl border border-black/10 bg-white p-4 text-sm text-brand underline">
            Watch the walkthrough
          </a>
        ) : null}

        <Card title="Breakdown" actions={<BreakdownButton id={sop.id} has={!!sop.breakdown} className="text-xs text-brand underline disabled:text-black/40" />}>
          {sop.breakdown ? (
            <Markdown text={sop.breakdown} />
          ) : sop.body ? (
            <>
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">This is the raw SOP. Press &ldquo;Write a clean breakdown&rdquo; to turn it into clear steps.</p>
              <div className="text-sm whitespace-pre-wrap text-black/80">{sop.body}</div>
            </>
          ) : (
            <Empty>No instructions yet. Edit the SOP to paste them, or attach a file.</Empty>
          )}
          {sop.fileName && (
            <p className="mt-4 border-t border-black/5 pt-3 text-sm">
              Attached:{" "}
              <a href={`/sops/${sop.id}/file`} target="_blank" className="text-brand underline">
                {sop.fileName}
              </a>
            </p>
          )}
          {sop.breakdown && sop.body && (
            <details className="mt-4 border-t border-black/5 pt-3 text-sm">
              <summary className="cursor-pointer text-black/50">Original notes / transcript</summary>
              <div className="mt-2 whitespace-pre-wrap text-black/70">{sop.body}</div>
            </details>
          )}
        </Card>

        {sop.steps.length > 0 && (
          <Card title="Checklist">
            <Checklist sopId={sop.id} steps={sop.steps} />
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <form action={toggleSopDone.bind(null, sop.id)}>
            <SubmitButton className={isDone ? btnGhost : btnBrand}>{isDone ? "✓ Completed (undo)" : "Mark complete"}</SubmitButton>
          </form>
          {next && (
            <Link href={`/sops/${next.id}`} className={btnGhost}>
              Next lesson: {next.title} →
            </Link>
          )}
        </div>

        <Card title="Agent runs of this SOP">
          {runs.length ? (
            <ul className="divide-y divide-black/5 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/agents/runs/${r.id}`} className="hover:underline">
                    {r.startedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })} · {r.trigger}
                    {r.clientId ? ` · ${clients.find((c) => c.id === r.clientId)?.name ?? `client ${r.clientId}`}` : ""}
                    {r.dryRun ? " · dry run" : ""}
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-black/50">
                    {r.proposed ? `${r.proposed} to approve` : ""}
                    <Badge tone={r.status === "completed" ? "green" : r.status === "running" ? "blue" : r.status === "error" ? "red" : "yellow"}>{r.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No agent runs yet.</Empty>
          )}
        </Card>
      </div>

      <aside className="space-y-6">
        <Card title={`${sop.category} · ${siblings.filter((s) => doneIds.has(s.id)).length}/${siblings.length}`}>
          <ol className="-my-1 space-y-0.5 text-sm">
            {siblings.map((s, i) => (
              <li key={s.id}>
                <Link href={`/sops/${s.id}`} className={`flex items-center gap-2 rounded px-2 py-1.5 ${s.id === sop.id ? "bg-brand-soft font-medium text-brand" : "hover:bg-black/5"}`}>
                  <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${doneIds.has(s.id) ? "bg-emerald-500 text-white" : "bg-black/10 text-black/60"}`}>{doneIds.has(s.id) ? "✓" : i + 1}</span>
                  <span className="truncate">{s.title}</span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Run it with an agent">
          <p className="mb-3 text-xs text-black/60">
            {sop.agentEnabled ? `${describeSchedule(sop)}.` : "Not scheduled. You can still run it now."} The agent {LEVEL[sop.autonomy]}
            {sop.toolkits.length ? ` and can use ${sop.toolkits.join(", ")}` : ""}.
          </p>
          <form action={runSopNow.bind(null, sop.id)} className="space-y-2">
            <select name="clientId" defaultValue="" className={input} aria-label="Client">
              <option value="">{sop.perClient ? "Every active client" : "No specific client"}</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  Only {c.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-black/70">
              <input type="checkbox" name="dryRun" defaultChecked /> Dry run (reads, changes nothing)
            </label>
            <SubmitButton className={btn} pendingText="Starting…">
              Run now
            </SubmitButton>
          </form>
        </Card>

        <Card title="Team progress">
          <ul className="space-y-1 text-sm">
            {users
              .filter((u) => u.active)
              .map((u) => {
                const d = everyone.find((e) => e.userId === u.id);
                return (
                  <li key={u.id} className="flex items-center justify-between">
                    <span>{u.name}</span>
                    {d ? <Badge tone="green">done {d.at.toLocaleDateString("en-IE", { timeZone: "Europe/Dublin" })}</Badge> : <span className="text-xs text-black/40">not yet</span>}
                  </li>
                );
              })}
          </ul>
        </Card>
      </aside>
    </div>
  );
}
