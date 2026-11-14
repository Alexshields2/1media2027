import Link from "next/link";
import { desc, eq, ne, and, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { mrr, monthTotals, overdue } from "@/lib/billing";
import { can } from "@/lib/roles";
import { requireUser } from "@/lib/session";
import { eur, monthLabel, monthStart, today, weekStart } from "@/lib/dates";
import { recentFailedRuns, runState, runTone } from "@/lib/runs";
import { modelReady } from "@/lib/runner";
import { Badge } from "./_components/ui";
import { Icon } from "./_components/icons";
import { AskJarvis } from "./chat/_components/ask-jarvis";
import { recentChats } from "./chat/load";
import { greeting } from "./_components/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SUGGESTIONS = ["Who owes us money right now?", "Which clients need attention this week?", "What should I focus on today?"];

type InboxItem = { key: string; tone: "red" | "yellow" | "brand"; title: string; detail?: string; href: string; when?: string };

export default async function Home() {
  const user = await requireUser();
  const month = monthStart();
  const [money, pending, health, dueTasks, runs, failedRuns, asked] = await Promise.all([
    moneyFigures(can(user.role, "money_stats")),
    db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).orderBy(desc(schema.approvals.createdAt)).limit(5),
    db
      .select({ h: schema.healthChecks, client: schema.clients.name })
      .from(schema.healthChecks)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
      .where(and(eq(schema.healthChecks.weekOf, weekStart()), ne(schema.healthChecks.status, "green"), eq(schema.healthChecks.resolved, false))),
    db
      .select({ t: schema.tasks, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(ne(schema.tasks.status, "done"), lte(schema.tasks.dueDate, today())))
      .orderBy(schema.tasks.dueDate)
      .limit(6),
    db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(5),
    recentFailedRuns(24),
    recentChats(user, "jarvis", 5),
  ]);

  const late = money?.late ?? [];
  const lateTotal = late.reduce((s, r) => s + r.owed, 0);
  const firstName = user.name.split(" ")[0] || user.name;
  const apiReady = modelReady();

  const inbox: InboxItem[] = [
    ...failedRuns.map((r) => ({
      key: `f${r.id}`,
      tone: "red" as const,
      title: `${r.agent} run ${runState(r) === "stalled" ? "didn't finish" : "failed"}`,
      detail: (r.error ?? r.summary ?? "Cut off before it finished").replace(/^Error:\s*/, "").slice(0, 140),
      href: `/agents/runs/${r.id}`,
    })),
    ...pending.map((a) => ({ key: `a${a.id}`, tone: "brand" as const, title: `${a.agent} wants to ${a.tool.replaceAll("_", " ").toLowerCase()}`, detail: "Waiting for your OK", href: "/approvals" })),
    ...health
      .filter(({ h }) => h.status === "red")
      .map(({ h, client }) => ({ key: `h${h.id}`, tone: "red" as const, title: `${client} is red this week`, detail: h.actionNeeded ?? undefined, href: "/health" })),
    ...late.slice(0, 4).map((p) => ({ key: `p${p.id}`, tone: "red" as const, title: `${p.client} owes ${eur(p.owed)}`, detail: `${monthLabel(p.period)} · ${p.days} days overdue`, href: "/payments" })),
    ...health
      .filter(({ h }) => h.status === "yellow")
      .map(({ h, client }) => ({ key: `y${h.id}`, tone: "yellow" as const, title: `${client} is yellow this week`, detail: h.actionNeeded ?? undefined, href: "/health" })),
  ].slice(0, 8);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* Centre: greeting + Ask Jarvis */}
      <section className="home-glow flex min-h-[70vh] flex-col items-center justify-center rounded-2xl border border-line bg-panel/40 px-4 py-12">
        <div className="flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] font-medium tracking-[0.22em] text-ink/70 uppercase">
          <span className="dot" /> 1Media OS · Jarvis
        </div>
        <h1 className="mt-6 text-center text-4xl font-bold tracking-[-0.03em] md:text-5xl">
          {greeting()}, <span className="brand-text">{firstName}</span>
        </h1>
        <p className="mt-2 text-center text-sm text-ink/50">Ask about any client, payment, report or task. Jarvis reads the whole OS.</p>

        <AskJarvis suggestions={SUGGESTIONS.filter((s) => money || !/money/i.test(s))} recent={asked} apiReady={apiReady} />

        <div className="mt-10 grid w-full max-w-xl grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { href: "/clients/new", label: "Add client" },
            money ? { href: "/payments", label: "Record payment" } : { href: "/health", label: "Client health" },
            { href: "/tasks", label: "New task" },
            { href: "/reports", label: "Reports" },
          ].map((q) => (
            <Link key={q.href} href={q.href} className="rounded-xl border border-line bg-panel px-3 py-2.5 text-center text-xs text-ink/60 hover:border-brand/40 hover:text-ink">
              {q.label}
            </Link>
          ))}
        </div>
      </section>

      {/* Right rail */}
      <aside className="space-y-4">
        <Rail title="Action inbox" count={inbox.length} href="/approvals">
          {inbox.length ? (
            <ul className="space-y-3">
              {inbox.map((i) => (
                <li key={i.key}>
                  <Link href={i.href} className="group flex gap-2.5">
                    <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${i.tone === "red" ? "bg-red-400" : i.tone === "yellow" ? "bg-amber-400" : "bg-brand-light"}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm group-hover:text-brand-light">{i.title}</span>
                      {i.detail && <span className="block truncate text-xs text-ink/40">{i.detail}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink/40">All clear. Nothing needs you.</p>
          )}
        </Rail>

        <Rail title="Due today" count={dueTasks.length} href="/tasks">
          {dueTasks.length ? (
            <ul className="space-y-2">
              {dueTasks.map(({ t, client }) => (
                <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    {t.title} {client && <span className="text-ink/40">· {client}</span>}
                  </span>
                  <span className="num shrink-0 text-xs text-ink/40">{t.dueDate === today() ? "today" : t.dueDate}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink/40">Nothing due.</p>
          )}
        </Rail>

        <Rail title="Agent activity" href="/agents">
          {runs.length ? (
            <ul className="space-y-2">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/agents/runs/${r.id}`} className="min-w-0 truncate hover:text-brand-light">
                    {r.agent}
                  </Link>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="num text-xs text-ink/40">{r.startedAt.toLocaleTimeString("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit" })}</span>
                    <Badge tone={runTone(runState(r))}>{runState(r)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink/40">No runs yet.</p>
          )}
        </Rail>

        {money && (
          <Rail title="Today's numbers" href="/dashboard">
            <div className="grid grid-cols-2 gap-2">
              <Num label="MRR ex VAT" value={eur(money.m.exVat)} hint={`${money.m.clients} clients`} />
              <Num label="Collected" value={eur(money.totals.collected)} hint={`${money.totals.due ? Math.round((money.totals.collected / money.totals.due) * 100) : 0}% of month`} tone="good" />
              <Num label="Outstanding" value={eur(money.totals.outstanding)} hint={monthLabel(month)} />
              <Num label="Overdue" value={eur(lateTotal)} hint={`${late.length} payments`} tone={lateTotal > 0 ? "bad" : undefined} />
            </div>
          </Rail>
        )}
      </aside>
    </div>
  );
}

function Rail({ title, count, href, children }: { title: string; count?: number; href: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {!!count && <span className="rounded-full bg-ink/[0.08] px-1.5 text-[11px] font-medium text-ink/60">{count}</span>}
        </h2>
        <Link href={href} className="text-ink/40 hover:text-ink">
          <Icon name="arrow" className="size-4" />
        </Link>
      </div>
      {children}
    </section>
  );
}

function Num({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-line bg-canvas/60 p-3">
      <div className="text-[11px] text-ink/45">{label}</div>
      <div className={`num mt-0.5 text-lg font-semibold ${tone === "bad" ? "text-red-400" : tone === "good" ? "text-emerald-400" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink/35">{hint}</div>}
    </div>
  );
}

/** Money figures, loaded only for people allowed to see them (never queried for team members). */
async function moneyFigures(allowed: boolean) {
  if (!allowed) return null;
  const [m, totals, late] = await Promise.all([mrr(), monthTotals(monthStart()), overdue()]);
  return { m, totals, late };
}
