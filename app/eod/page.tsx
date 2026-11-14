import Link from "next/link";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { today } from "@/lib/dates";
import { allUsers, requireUser } from "@/lib/session";
import { canSee } from "@/lib/team";
import { saveEod } from "../actions";
import { Badge, Card, Empty, PageHeader, btnBrand, field, input, label } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";
import { DictateTextarea } from "../_components/voice-recorder";

export const dynamic = "force-dynamic";

export default async function EodPage({ searchParams }: { searchParams: Promise<{ date?: string; person?: string; saved?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const users = await allUsers();
  const t0 = today();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) && sp.date <= t0 ? sp.date : t0;
  const visible = users.filter((u) => u.active && canSee(users, me.id, u.id));
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);

  const [mine, completed, recent] = await Promise.all([
    db.select().from(schema.eodReports).where(and(eq(schema.eodReports.userId, me.id), eq(schema.eodReports.date, date))),
    db
      .select({ title: schema.tasks.title, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(eq(schema.tasks.assigneeId, me.id), eq(schema.tasks.status, "done"), gte(schema.tasks.completedAt, new Date(`${date}T00:00:00Z`)))),
    db
      .select()
      .from(schema.eodReports)
      .where(and(inArray(schema.eodReports.userId, visible.map((u) => u.id)), gte(schema.eodReports.date, since), sp.person ? eq(schema.eodReports.userId, Number(sp.person)) : undefined))
      .orderBy(desc(schema.eodReports.date), desc(schema.eodReports.updatedAt)),
  ]);
  const existing = mine[0];
  const suggestion = completed.length ? completed.map((c) => `- ${c.title}${c.client ? ` (${c.client})` : ""}`).join("\n") : "";
  // People who should send an EOD: everyone who reports to someone, that I can see.
  const expected = visible.filter((u) => u.managerId !== null);
  const sentToday = new Set(recent.filter((r) => r.date === t0).map((r) => r.userId));
  const nameOf = (id: number) => users.find((u) => u.id === id)?.name ?? "?";

  return (
    <>
      <PageHeader title="End of day" subtitle="What you got done, what's blocking you, and what's next. Your manager sees it, and it feeds tomorrow's morning brief." />

      {sp.saved && <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Saved. Thanks{me.name ? `, ${me.name}` : ""}.</div>}

      {expected.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-black/50">Today:</span>
          {expected.map((u) => (
            <Badge key={u.id} tone={sentToday.has(u.id) ? "green" : "yellow"}>
              {u.name} {sentToday.has(u.id) ? "✓ sent" : "not yet"}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title={`Your report for ${date === t0 ? "today" : date}`} actions={existing ? <Badge tone="green">sent, you can update it</Badge> : undefined}>
          <form action={saveEod} className="space-y-4">
            <input type="hidden" name="date" value={date} />
            <div>
              <span className={label}>What did you get done?</span>
              <DictateTextarea key={`done-${date}`} name="done" rows={6} required defaultValue={existing?.done ?? suggestion} placeholder="- Built the GHL pipeline for Demo Paving&#10;- Weekly reports sent for 6 clients" />
              {!existing && completed.length > 0 && <p className="mt-1 text-xs text-black/50">Filled in from the {completed.length} task(s) you marked done today. Add anything else.</p>}
            </div>
            <div>
              <span className={label}>Blockers or problems</span>
              <DictateTextarea key={`blockers-${date}`} name="blockers" rows={3} defaultValue={existing?.blockers ?? ""} placeholder="Waiting on…, stuck on…, need a decision on…" />
            </div>
            <div>
              <span className={label}>Plan for tomorrow</span>
              <DictateTextarea key={`tomorrow-${date}`} name="tomorrow" rows={3} defaultValue={existing?.tomorrow ?? ""} />
            </div>
            <SubmitButton className={btnBrand} pendingText="Saving…">
              {existing ? "Update report" : "Send end-of-day report"}
            </SubmitButton>
          </form>
          <form className="mt-4 flex items-center gap-1 border-t border-black/5 pt-3 text-xs text-black/50">
            <span>Fill in or fix another day:</span>
            <input type="date" name="date" max={t0} defaultValue={date} className={`${field} py-1 text-xs`} aria-label="Date" />
            <button className="underline">Open</button>
          </form>
        </Card>

        <Card
          title="Recent reports"
          actions={
            visible.length > 1 ? (
              <form className="flex gap-1">
                <select name="person" defaultValue={sp.person ?? ""} className={`${input} py-1 text-xs`} aria-label="Person">
                  <option value="">Everyone I can see</option>
                  {visible.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <button className="text-xs underline">Show</button>
              </form>
            ) : undefined
          }
        >
          {recent.length ? (
            <ul className="space-y-4">
              {recent.map((r) => (
                <li key={r.id} className="rounded-lg border border-black/10 p-3 text-sm">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-medium">{nameOf(r.userId)}</span>
                    <span className="text-xs text-black/50">{r.date}</span>
                  </div>
                  <p className="whitespace-pre-line text-black/80">{r.done}</p>
                  {r.blockers && (
                    <p className="mt-2 rounded bg-amber-50 px-2 py-1 whitespace-pre-line text-amber-900">
                      <span className="font-medium">Blockers:</span> {r.blockers}
                    </p>
                  )}
                  {r.tomorrow && (
                    <p className="mt-2 whitespace-pre-line text-black/60">
                      <span className="font-medium">Tomorrow:</span> {r.tomorrow}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No reports in the last 3 weeks.</Empty>
          )}
          <p className="mt-3 text-xs text-black/50">
            You see your own reports and those of people who report to you. <Link href="/team" className="underline">Team</Link>
          </p>
        </Card>
      </div>
    </>
  );
}
