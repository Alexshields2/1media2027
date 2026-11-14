import Link from "next/link";
import { desc, eq, ne, and, lte, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { runState, runTone } from "@/lib/runs";
import { mrr, monthTotals, overdue, round2 } from "@/lib/billing";
import { can } from "@/lib/roles";
import { addMonths, eur, monthLabel, monthStart, today, weekStart } from "@/lib/dates";
import { describeAction } from "@/lib/approvals";
import { Badge, Card, CardLink, DueChip, Empty, HealthDot, List, PageHeader, Progress, SectionTitle, Stat, pctChange } from "../_components/ui";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const shortMonth = (p: string) => new Date(`${p}T12:00:00Z`).toLocaleDateString("en-IE", { month: "short", timeZone: "UTC" });
const runTime = (d: Date) => d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", weekday: "short", hour: "2-digit", minute: "2-digit" });

export default async function Dashboard() {
  const user = await requireUser();
  const month = monthStart();
  const t0 = today();
  const week = weekStart();
  const sixWeeksAgo = new Date(Date.parse(`${week}T12:00:00Z`) - 5 * 7 * 86_400_000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000);
  weekAgo.setHours(0, 0, 0, 0);

  const [money, pending, health, history, dueTasks, openTasks, runs, recentRuns] = await Promise.all([
    moneyFigures(can(user.role, "money_stats")),
    db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).orderBy(desc(schema.approvals.createdAt)).limit(5),
    db
      .select({ h: schema.healthChecks, client: schema.clients.name })
      .from(schema.healthChecks)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
      .where(and(eq(schema.healthChecks.weekOf, week), ne(schema.healthChecks.status, "green"), eq(schema.healthChecks.resolved, false))),
    db.select({ weekOf: schema.healthChecks.weekOf, status: schema.healthChecks.status }).from(schema.healthChecks).where(gte(schema.healthChecks.weekOf, sixWeeksAgo)),
    db
      .select({ t: schema.tasks, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(ne(schema.tasks.status, "done"), lte(schema.tasks.dueDate, t0)))
      .orderBy(schema.tasks.dueDate)
      .limit(6),
    db.select({ status: schema.tasks.status, dueDate: schema.tasks.dueDate }).from(schema.tasks).where(ne(schema.tasks.status, "done")),
    db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(5),
    db.select({ startedAt: schema.agentRuns.startedAt, status: schema.agentRuns.status }).from(schema.agentRuns).where(gte(schema.agentRuns.startedAt, weekAgo)),
  ]);

  // Six weeks of red + yellow counts, oldest first.
  const weeks = Array.from({ length: 6 }, (_, i) => new Date(Date.parse(`${sixWeeksAgo}T12:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10));
  const attentionByWeek = weeks.map((w) => history.filter((h) => h.weekOf === w && h.status !== "green").length);
  const attentionNow = health.length;
  const attentionLast = attentionByWeek[attentionByWeek.length - 2] ?? 0;
  // Seven days of agent runs, oldest first.
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekAgo.getTime() + i * 86_400_000).toDateString());
  const runsByDay = days.map((d) => recentRuns.filter((r) => r.startedAt.toDateString() === d).length);
  const failed7 = recentRuns.filter((r) => r.status === "error").length;
  const tasksOverdue = openTasks.filter((t) => t.dueDate && t.dueDate < t0).length;

  const late = money?.late ?? [];
  const lateTotal = round2(late.reduce((s, r) => s + r.owed, 0));
  const collectedPct = money?.totals.due ? Math.round((money.totals.collected / money.totals.due) * 100) : 0;
  const series = money?.series ?? [];
  const billedNow = series.at(-1)?.billed ?? 0;
  const billedBefore = series.at(-2)?.billed ?? 0;

  return (
    <>
      <PageHeader
        eyebrow={monthLabel(month)}
        title="Dashboard"
        subtitle={`${new Date(`${t0}T12:00:00Z`).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })} · the agency at a glance`}
      />

      {money && (
        <>
          <SectionTitle>Money</SectionTitle>
          <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="MRR ex VAT"
              icon="trend"
              value={eur(money.m.exVat)}
              hint={`${money.m.clients} active clients`}
              spark={series.map((s) => s.billed)}
              delta={{ pct: pctChange(billedNow, billedBefore), label: "billed" }}
              href="/clients?view=table"
            />
            <Stat label="Collected" icon="euro" value={eur(money.totals.collected)} tone="good" hint={`${collectedPct}% of ${eur(money.totals.due)} this month`} href="/payments">
              <Progress value={money.totals.collected} max={money.totals.due} tone="green" label="Collected this month" className="mt-3" />
            </Stat>
            <Stat
              label="Outstanding"
              icon="clock"
              value={eur(money.totals.outstanding)}
              hint={money.totals.count ? `${monthLabel(month)} · ${money.totals.count} rows` : "No rows yet: generate the month in Payments"}
              href="/payments"
            />
            <Stat
              label="Overdue"
              icon="alert"
              value={eur(lateTotal)}
              tone={lateTotal > 0 ? "bad" : undefined}
              hint={late.length ? `${late.length} payments · oldest ${late[0].days} days` : "Nothing overdue"}
              href="/payments#aging"
            />
          </div>
        </>
      )}

      <SectionTitle>Delivery</SectionTitle>
      <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Need attention"
          icon="pulse"
          value={attentionNow}
          tone={health.some((h) => h.h.status === "red") ? "bad" : attentionNow ? "warn" : "good"}
          hint="Red or yellow clients this week"
          spark={attentionByWeek}
          delta={{ pct: pctChange(attentionNow, attentionLast), goodWhen: "down" }}
          href="/health"
        />
        <Stat label="Open tasks" icon="check" value={openTasks.length} hint={tasksOverdue ? `${tasksOverdue} overdue` : "None overdue"} tone={tasksOverdue ? "warn" : undefined} href="/tasks" />
        <Stat label="Approvals waiting" icon="shield" value={pending.length} hint={pending.length ? "Agents are waiting on you" : "Nothing waiting"} href="/approvals" />
        <Stat
          label="Agent runs · 7 days"
          icon="spark"
          value={recentRuns.length}
          hint={failed7 ? `${failed7} failed` : "No failures"}
          tone={failed7 ? "bad" : undefined}
          spark={runsByDay}
          href="/agents"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card title="Clients needing attention" description="This week's red and yellow, not yet resolved" actions={<CardLink href="/health">Client health</CardLink>}>
            {health.length ? (
              <List>
                {health
                  .sort((a, b) => (a.h.status === b.h.status ? 0 : a.h.status === "red" ? -1 : 1))
                  .map(({ h, client }) => (
                    <li key={h.id} className="py-3">
                      <Link href={`/clients/${h.clientId}`} className="group flex items-start gap-3">
                        <ClientLogo name={client} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium text-white group-hover:text-brand-light">{client}</span>
                            <HealthDot status={h.status} size="sm" label={h.status} />
                            {h.issue && <span className="hidden truncate text-xs text-muted sm:inline">{h.issue}</span>}
                          </span>
                          {h.actionNeeded && <span className="mt-0.5 block text-sm text-soft">{h.actionNeeded}</span>}
                        </span>
                        <Badge tone={h.status} dot>
                          {h.status}
                        </Badge>
                      </Link>
                    </li>
                  ))}
              </List>
            ) : (
              <Empty icon="pulse" title="Every client is green" compact>
                No red or yellow clients this week.
              </Empty>
            )}
          </Card>

          <Card title="Tasks due" description="Due today or overdue" actions={<CardLink href="/tasks">Board</CardLink>}>
            {dueTasks.length ? (
              <List>
                {dueTasks.map(({ t, client }) => (
                  <li key={t.id} className="flex items-center gap-3 py-2.5">
                    {client ? <ClientLogo name={client} size={28} className="rounded-lg" /> : <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line text-muted">·</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-white">{t.title}</span>
                      {client && <span className="block truncate text-xs text-muted">{client}</span>}
                    </span>
                    <DueChip date={t.dueDate} today={t0} />
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="check" title="Nothing due" compact action={<Link href="/tasks" className="text-sm font-medium text-brand-light hover:text-white">Open the board →</Link>} />
            )}
          </Card>

          <Card title="Recent agent runs" actions={<CardLink href="/agents">Agents</CardLink>}>
            {runs.length ? (
              <List>
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link href={`/agents/runs/${r.id}`} className="group flex items-center gap-3 py-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-canvas/60 text-brand-light">
                        <Icon name="spark" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-white capitalize group-hover:text-brand-light">{r.agent.replaceAll("-", " ")}</span>
                        <span className="block truncate text-xs text-muted">{r.error ?? r.summary ?? r.trigger}</span>
                      </span>
                      <span className="num hidden text-xs text-muted sm:inline">{runTime(r.startedAt)}</span>
                      <Badge tone={runTone(runState(r))} dot>
                        {runState(r)}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="spark" title="No runs yet" compact>
                Agents run on their schedule, or start one from the Agents page.
              </Empty>
            )}
          </Card>
        </div>

        <aside className="min-w-0 space-y-6">
          {money && (
            <Card title="MRR by client" description={`${eur(money.m.exVat)} ex VAT across ${money.m.clients} clients`} actions={<CardLink href="/clients?view=table">Clients</CardLink>}>
              {money.byClient.length ? (
                <ul className="space-y-3">
                  {money.byClient.map((c) => (
                    <li key={c.id}>
                      <Link href={`/clients/${c.id}`} className="group flex items-center gap-3">
                        <ClientLogo name={c.name} size={28} className="rounded-lg" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="truncate text-soft group-hover:text-white">{c.name}</span>
                            <span className="num shrink-0 font-medium text-white">{eur(c.retainerExVat)}</span>
                          </span>
                          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
                            <span className="brand-gradient block h-full rounded-full" style={{ width: `${Math.max(3, (c.retainerExVat / money.byClient[0].retainerExVat) * 100)}%` }} />
                          </span>
                        </span>
                        <span className="num w-9 shrink-0 text-right text-xs text-muted">{money.m.exVat ? Math.round((c.retainerExVat / money.m.exVat) * 100) : 0}%</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty icon="users" compact>
                  No active clients with a retainer.
                </Empty>
              )}
              {series.length > 1 && (
                <div className="mt-5 border-t border-line pt-4">
                  <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Billed vs collected</div>
                  <div className="flex h-24 items-end gap-2" role="img" aria-label={`Billed and collected per month: ${series.map((s) => `${shortMonth(s.period)} ${eur(s.billed)} billed, ${eur(s.collected)} collected`).join("; ")}`}>
                    {(() => {
                      const max = Math.max(...series.map((s) => s.billed), 1);
                      return series.map((s) => (
                        <div key={s.period} className="flex flex-1 flex-col items-center gap-1.5">
                          <div className="relative flex h-20 w-full items-end justify-center">
                            <div className="absolute bottom-0 w-full max-w-7 rounded-t-md bg-ink/[0.08]" style={{ height: `${(s.billed / max) * 100}%` }} />
                            <div className="brand-gradient absolute bottom-0 w-full max-w-7 rounded-t-md opacity-90" style={{ height: `${(s.collected / max) * 100}%` }} />
                          </div>
                          <span className="text-[10px] text-muted">{shortMonth(s.period)}</span>
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="mt-2 flex gap-4 text-[11px] text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="brand-gradient size-2 rounded-sm" /> Collected
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-sm bg-ink/20" /> Billed
                    </span>
                  </div>
                </div>
              )}
            </Card>
          )}

          <Card title="Needs your OK" actions={<CardLink href="/approvals">Approvals</CardLink>}>
            {pending.length ? (
              <List>
                {pending.map((a) => (
                  <li key={a.id} className="py-2.5">
                    <Link href="/approvals" className="group block">
                      <span className="block truncate text-sm text-white group-hover:text-brand-light">{describeAction(a.tool, a.input)}</span>
                      <span className="mt-0.5 block text-xs text-muted capitalize">{a.agent} agent · waiting for you</span>
                    </Link>
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="shield" compact>
                Nothing waiting for approval.
              </Empty>
            )}
          </Card>

          {money && (
            <Card title="Overdue payments" actions={<CardLink href="/payments">Payments</CardLink>}>
              {late.length ? (
                <List>
                  {late.slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2.5">
                      <ClientLogo name={p.client} size={28} className="rounded-lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-white">{p.client}</span>
                        <span className="block text-xs text-muted">{monthLabel(p.period)}</span>
                      </span>
                      <span className="text-right">
                        <span className="num block font-medium text-white">{eur(p.owed)}</span>
                        <span className={`num block text-[11px] ${p.days > 30 ? "text-red-300" : "text-amber-300"}`}>{p.days} days</span>
                      </span>
                    </li>
                  ))}
                </List>
              ) : (
                <Empty icon="euro" compact>
                  Nothing overdue.
                </Empty>
              )}
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}


/** Money figures, loaded only for people allowed to see them (never queried for team members). */
async function moneyFigures(allowed: boolean) {
  if (!allowed) return null;
  const month = monthStart();
  const from = addMonths(month, -5);
  const [m, totals, late, byPeriod, byClient] = await Promise.all([
    mrr(),
    monthTotals(month),
    overdue(),
    db
      .select({
        period: schema.payments.period,
        billed: sql<string>`sum(${schema.payments.amountDue})`,
        collected: sql<string>`sum(${schema.payments.amountCollected})`,
      })
      .from(schema.payments)
      .where(and(gte(schema.payments.period, from), lte(schema.payments.period, month)))
      .groupBy(schema.payments.period)
      .orderBy(schema.payments.period),
    db
      .select({ id: schema.clients.id, name: schema.clients.name, retainerExVat: schema.clients.retainerExVat })
      .from(schema.clients)
      .where(eq(schema.clients.status, "active"))
      .orderBy(desc(schema.clients.retainerExVat)),
  ]);
  const series = byPeriod.map((r) => ({ period: r.period, billed: round2(Number(r.billed)), collected: round2(Number(r.collected)) }));
  return { m, totals, late, series, byClient: byClient.filter((c) => c.retainerExVat > 0) };
}
