import Link from "next/link";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { SOP_TEMPLATES, describeSchedule } from "@/lib/sops";
import { Badge, Empty, PageHeader, btnBrand, btnGhost, field } from "../_components/ui";

export const dynamic = "force-dynamic";

const TINTS = ["from-orange-400 to-rose-500", "from-sky-400 to-indigo-500", "from-emerald-400 to-teal-600", "from-violet-400 to-fuchsia-500", "from-amber-400 to-orange-500", "from-slate-500 to-slate-700"];

export default async function SopLibrary({ searchParams }: { searchParams: Promise<{ q?: string; archived?: string; module?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [sops, done, users] = await Promise.all([
    db
      .select({
        id: schema.sops.id,
        title: schema.sops.title,
        category: schema.sops.category,
        summary: schema.sops.summary,
        videoUrl: schema.sops.videoUrl,
        steps: schema.sops.steps,
        ownerId: schema.sops.ownerId,
        agentEnabled: schema.sops.agentEnabled,
        schedule: schema.sops.schedule,
        weekday: schema.sops.weekday,
        monthDay: schema.sops.monthDay,
        perClient: schema.sops.perClient,
        archived: schema.sops.archived,
        hasBreakdown: schema.sops.breakdown,
      })
      .from(schema.sops)
      .where(
        and(
          eq(schema.sops.archived, sp.archived === "1"),
          sp.q ? or(ilike(schema.sops.title, `%${sp.q}%`), ilike(schema.sops.summary, `%${sp.q}%`), ilike(schema.sops.body, `%${sp.q}%`), ilike(schema.sops.breakdown, `%${sp.q}%`)) : undefined,
          sp.module ? eq(schema.sops.category, sp.module) : undefined,
        ),
      )
      .orderBy(asc(schema.sops.category), asc(schema.sops.position), asc(schema.sops.title)),
    db.select({ sopId: schema.sopProgress.sopId }).from(schema.sopProgress).where(eq(schema.sopProgress.userId, me.id)),
    allUsers(),
  ]);
  const doneIds = new Set(done.map((d) => d.sopId));
  const modules = [...new Set(sops.map((s) => s.category))];
  const total = sops.length;
  const completed = sops.filter((s) => doneIds.has(s.id)).length;

  return (
    <>
      <PageHeader
        title="SOP library"
        subtitle="How we do everything at 1Media: one lesson per process, with the Loom walkthrough, a clean breakdown and a checklist. Hand any SOP to an agent to run it on a schedule."
        actions={
          <Link href="/sops/new" className={btnBrand}>
            New SOP
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form className="flex flex-1 gap-2">
          <input name="q" defaultValue={sp.q} placeholder="Search SOPs" className={`${field} min-w-0 flex-1`} aria-label="Search SOPs" />
          {sp.archived && <input type="hidden" name="archived" value="1" />}
          <button className={btnGhost}>Search</button>
        </form>
        <Link href={sp.archived ? "/sops" : "/sops?archived=1"} className="text-sm text-black/50 underline">
          {sp.archived ? "Back to library" : "Archived"}
        </Link>
        {total > 0 && !sp.archived && (
          <div className="flex items-center gap-2 text-sm text-black/60">
            <div className="h-2 w-28 overflow-hidden rounded-full bg-black/10">
              <div className="h-full bg-brand" style={{ width: `${Math.round((completed / total) * 100)}%` }} />
            </div>
            You&rsquo;ve completed {completed}/{total}
          </div>
        )}
      </div>

      {!sops.length && (
        <div className="rounded-xl border border-dashed border-black/15 bg-white p-6">
          <Empty>{sp.q || sp.archived ? "No SOPs match." : "No SOPs yet. Start from a template, or add your own."}</Empty>
          {!sp.q && !sp.archived && (
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {SOP_TEMPLATES.map((t) => (
                <Link key={t.key} href={`/sops/new?template=${t.key}`} className="rounded-lg border border-black/10 p-3 text-sm hover:border-brand">
                  <div className="font-medium">{t.title}</div>
                  <div className="mt-1 text-xs text-black/60">{t.summary}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-10">
        {modules.map((m, mi) => {
          const lessons = sops.filter((s) => s.category === m);
          const n = lessons.filter((s) => doneIds.has(s.id)).length;
          return (
            <section key={m}>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">{m}</h2>
                  <p className="text-xs text-black/50">
                    {lessons.length} lesson{lessons.length === 1 ? "" : "s"} · {n} completed
                  </p>
                </div>
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/10">
                  <div className="h-full bg-emerald-500" style={{ width: `${lessons.length ? Math.round((n / lessons.length) * 100) : 0}%` }} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {lessons.map((s) => (
                  <Link key={s.id} href={`/sops/${s.id}`} className="group overflow-hidden rounded-xl border border-black/10 bg-white transition hover:border-brand hover:shadow-sm">
                    <div className={`relative grid h-28 place-items-center bg-gradient-to-br ${TINTS[mi % TINTS.length]} text-white`}>
                      <span className="px-4 text-center text-sm font-semibold drop-shadow">{s.title}</span>
                      {s.videoUrl && <span className="absolute top-2 right-2 rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-medium">▶ Video</span>}
                      {doneIds.has(s.id) && <span className="absolute top-2 left-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-700">✓ Done</span>}
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-black/70">{s.summary ?? "No summary yet."}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-black/50">
                        {s.agentEnabled ? <Badge tone="brand">{describeSchedule(s)}</Badge> : <Badge tone="gray">People only</Badge>}
                        {s.steps.length > 0 && <span>{s.steps.length} steps</span>}
                        {s.ownerId && <span>· {users.find((u) => u.id === s.ownerId)?.name}</span>}
                        {!s.hasBreakdown && <span className="text-amber-700">· needs breakdown</span>}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
