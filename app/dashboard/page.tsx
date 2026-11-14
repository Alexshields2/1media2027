import Link from "next/link";
import { eq, ne, and, lte, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { mrr, overdue, round2 } from "@/lib/billing";
import { can } from "@/lib/roles";
import { addMonths, eur, monthLabel, monthStart, today, weekStart } from "@/lib/dates";
import { loadWeeklyStandards } from "@/lib/weekly-standard";
import { RATING_WINDOW_DAYS, teamPerformance } from "@/lib/team-performance";
import { Badge, Card, CardLink, DueChip, Empty, HealthDot, List, PageHeader, Progress, SectionTitle, Stat } from "../_components/ui";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { requireUser } from "@/lib/session";
import { RevenueChart } from "./revenue-chart";

export const dynamic = "force-dynamic";

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", timeZone: "UTC" });

export default async function Dashboard() {
  const user = await requireUser();
  const money = can(user.role, "money_stats");
  const t0 = today();
  const week = weekStart();
  const yearStart = `${t0.slice(0, 4)}-01-01`;
  const ratingFrom = new Date(Date.now() - (RATING_WINDOW_DAYS + 1) * 86_400_000);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000);
  weekAgo.setHours(0, 0, 0, 0);

  const [clients, revenue, standards, attention, dueTasks, ratingTasks, pending, runs] = await Promise.all([
    db
      .select({ id: schema.clients.id, name: schema.clients.name, status: schema.clients.status, retainerExVat: schema.clients.retainerExVat, startDate: schema.clients.startDate })
      .from(schema.clients),
    money ? revenueFigures(yearStart) : Promise.resolve(null),
    loadWeeklyStandards({ billing: can(user.role, "payments") }),
    db
      .select({ h: schema.healthChecks, client: schema.clients.name })
      .from(schema.healthChecks)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
      .where(and(eq(schema.healthChecks.weekOf, week), ne(schema.healthChecks.status, "green"), eq(schema.healthChecks.resolved, false))),
    db
      .select({ t: schema.tasks, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(ne(schema.tasks.status, "done"), lte(schema.tasks.dueDate, t0)))
      .orderBy(schema.tasks.dueDate)
      .limit(5),
    db
      .select({ assignee: schema.tasks.assignee, status: schema.tasks.status, dueDate: schema.tasks.dueDate, completedAt: schema.tasks.completedAt })
      .from(schema.tasks)
      .where(sql`${schema.tasks.status} <> 'done' or ${schema.tasks.completedAt} >= ${ratingFrom.toISOString()}`),
    db.select({ id: schema.approvals.id }).from(schema.approvals).where(eq(schema.approvals.status, "pending")),
    db.select({ status: schema.agentRuns.status }).from(schema.agentRuns).where(gte(schema.agentRuns.startedAt, weekAgo)),
  ]);

  // Clients
  const active = clients.filter((c) => c.status === "active");
  const paying = active.filter((c) => c.retainerExVat > 0);
  const avgRetainer = paying.length ? round2(paying.reduce((s, c) => s + c.retainerExVat, 0) / paying.length) : 0;
  const newThisYear = clients.filter((c) => c.startDate && c.startDate >= yearStart && c.status !== "churned").length;
  const onboarding = clients.filter((c) => c.status === "onboarding").length;
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  // Weekly standard: least complete first
  const std = [...standards.values()].sort((a, b) => a.done / a.total - b.done / b.total || (nameOf.get(a.clientId) ?? "").localeCompare(nameOf.get(b.clientId) ?? ""));
  const onStd = std.filter((s) => s.onStandard).length;
  const offStd = std.length - onStd;

  // Team
  const team = teamPerformance(ratingTasks, t0);
  const teamAvg = team.length ? Math.round(team.reduce((s, p) => s + p.score, 0) / team.length) : null;

  const failedRuns = runs.filter((r) => r.status === "error").length;

  return (
    <>
      <PageHeader
        eyebrow={monthLabel(monthStart())}
        title="Dashboard"
        subtitle={`${new Date(`${t0}T12:00:00Z`).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })} · the agency at a glance`}
      />

      {/* 1. Revenue and clients */}
      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        {revenue && (
          <section className="surface relative min-w-0 overflow-hidden rounded-3xl border border-line bg-panel p-5 sm:p-6 lg:col-span-2">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_20%_0%,rgb(4_153_242/0.14),transparent_70%)]" />
            <div className="relative">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">Revenue · {t0.slice(0, 4)} to date</div>
                  <div className="num mt-1.5 text-4xl font-bold tracking-[-0.03em] sm:text-5xl">
                    <span className="brand-text">{eur(revenue.collected)}</span>
                  </div>
                  <div className="mt-1.5 text-sm text-soft">
                    collected of <span className="num text-white">{eur(revenue.billed)}</span> billed ·{" "}
                    <span className={revenue.rate >= 90 ? "text-emerald-300" : "text-amber-300"}>{revenue.rate}% collected</span>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 sm:text-right">
                  <div>
                    <dt className="text-[11px] tracking-[0.1em] text-muted uppercase">This month</dt>
                    <dd className="num mt-0.5 text-lg font-semibold text-white">{eur(revenue.thisMonth)}</dd>
                    <dd className="text-xs text-muted">so far</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] tracking-[0.1em] text-muted uppercase">Best month</dt>
                    <dd className="num mt-0.5 text-lg font-semibold text-white">{revenue.best ? eur(revenue.best.collected) : "–"}</dd>
                    <dd className="text-xs text-muted">{revenue.best ? new Date(`${revenue.best.period}T12:00:00Z`).toLocaleDateString("en-IE", { month: "long", timeZone: "UTC" }) : ""}</dd>
                  </div>
                </dl>
              </div>
              <div className="mt-5">
                {revenue.months.length ? (
                  <RevenueChart months={revenue.months} />
                ) : (
                  <Empty icon="chart" compact title="No payments this year yet">
                    Generate the month in Payments and record what comes in.
                  </Empty>
                )}
              </div>
            </div>
          </section>
        )}

        <div className={`grid min-w-0 content-start gap-4 ${revenue ? "sm:grid-cols-3 lg:grid-cols-1" : "sm:grid-cols-2 lg:col-span-3 lg:grid-cols-4"}`}>
          <Stat
            label="Active clients"
            icon="users"
            value={active.length}
            hint={[newThisYear ? `${newThisYear} new this year` : null, onboarding ? `${onboarding} onboarding` : null].filter(Boolean).join(" · ") || "All set up"}
            href="/clients"
          />
          {money && (
            <Stat
              label="Average retainer"
              icon="euro"
              value={eur(avgRetainer)}
              hint={paying.length ? `ex VAT · ranges ${eur(Math.min(...paying.map((c) => c.retainerExVat)))}–${eur(Math.max(...paying.map((c) => c.retainerExVat)))}` : "ex VAT"}
              href="/clients?view=table"
            />
          )}
          {revenue && <Stat label="MRR ex VAT" icon="trend" value={eur(revenue.mrr)} hint={`${revenue.mrrClients} active clients`} spark={revenue.months.map((m) => m.billed)} href="/payments" />}
          {!money && (
            <>
              <Stat label="Need attention" icon="pulse" value={attention.length} tone={attention.length ? "warn" : "good"} hint="Red or yellow this week" href="/health" />
              <Stat label="Approvals waiting" icon="shield" value={pending.length} href="/approvals" />
              <Stat label="Team score" icon="check" value={teamAvg ?? "–"} hint={`Average, last ${RATING_WINDOW_DAYS} days`} />
            </>
          )}
        </div>
      </div>

      {/* 2. Weekly standard + team */}
      <div className="mb-8 grid gap-4 lg:grid-cols-5">
        <Card
          className="lg:col-span-3"
          title="Weekly standard"
          description={`Week of ${shortDate(week)} · ${offStd ? `${offStd} client${offStd === 1 ? "" : "s"} off standard. Open one to see its checklist.` : "every client is on standard"}`}
          actions={
            <Badge tone={offStd ? "yellow" : "green"} dot>
              {onStd} of {std.length} on standard
            </Badge>
          }
          flush
        >
          <div className="px-5 pt-4">
            <Progress value={onStd} max={std.length || 1} tone={offStd ? "brand" : "green"} label="Clients on the weekly standard" />
          </div>
          {std.length ? (
            <ul className="mt-2 divide-y divide-line/70">
              {std.map((s) => {
                const name = nameOf.get(s.clientId) ?? "Client";
                const missing = s.items.filter((i) => !i.done);
                return (
                  <li key={s.clientId}>
                    <Link href={`/clients/${s.clientId}#weekly-standard`} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-ink/[0.025]">
                      <ClientLogo name={name} size={34} className="rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-white group-hover:text-brand-light">{name}</span>
                          {s.onStandard && <Icon name="check" className="size-4 shrink-0 text-emerald-300" />}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {missing.length ? (
                            missing.slice(0, 3).map((i) => (
                              <span key={i.key} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 ring-1 ring-amber-400/20 ring-inset">
                                {i.label}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted">Everything done this week</span>
                          )}
                          {missing.length > 3 && <span className="px-1 text-[11px] text-muted">+{missing.length - 3} more</span>}
                        </div>
                      </div>
                      <div className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden>
                        {s.items.map((i) => (
                          <span key={i.key} title={`${i.label}: ${i.detail}`} className={`size-2 rounded-full ${i.done ? "bg-emerald-400" : "bg-ink/15 ring-1 ring-amber-400/50"}`} />
                        ))}
                      </div>
                      <span className={`num w-10 shrink-0 text-right text-sm font-semibold ${s.onStandard ? "text-emerald-300" : "text-white"}`}>
                        {s.done}/{s.total}
                      </span>
                      <Icon name="chevronRight" className="size-4 shrink-0 text-muted group-hover:text-white" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty icon="users" compact>
              No active clients yet.
            </Empty>
          )}
        </Card>

        <Card
          className="lg:col-span-2"
          title="Team performance"
          description={`Last ${RATING_WINDOW_DAYS} days, from the tasks assigned to each person`}
          actions={
            teamAvg != null ? (
              <span className="num text-sm text-soft">
                Team <span className="font-semibold text-white">{teamAvg}</span>/100
              </span>
            ) : undefined
          }
        >
          {team.length ? (
            <ul className="space-y-3">
              {team.map((p) => (
                <li key={p.name} className="flex items-center gap-4 rounded-xl border border-line bg-canvas/50 p-3">
                  <ScoreRing score={p.score} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-white">{p.name}</span>
                      <Badge tone={p.label === "Excellent" ? "green" : p.label === "Good" ? "brand" : p.label === "Needs focus" ? "yellow" : "red"} dot>
                        {p.label}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                      <span>
                        <span className="num text-white">{p.done}</span> done
                      </span>
                      <span>
                        <span className="num text-white">{p.done ? Math.round((p.onTime / p.done) * 100) : 0}%</span> on time
                      </span>
                      <span className={p.overdue ? "text-red-300" : ""}>
                        <span className="num">{p.overdue}</span> overdue
                      </span>
                      <span>
                        <span className="num text-white">{p.open}</span> open
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              icon="users"
              compact
              title="No ratings yet"
              action={
                <Link href="/tasks" className="text-sm font-medium text-brand-light hover:text-white">
                  Assign tasks on the board →
                </Link>
              }
            >
              Ratings appear once tasks have someone assigned.
            </Empty>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-muted">Score: 70% finishing on time, 30% output against the busiest person, minus 8 for each task overdue right now.</p>
        </Card>
      </div>

      {/* 3. Today */}
      <SectionTitle>Today</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Clients needing attention" actions={<CardLink href="/health">Health</CardLink>}>
          {attention.length ? (
            <List>
              {attention
                .sort((a, b) => (a.h.status === b.h.status ? 0 : a.h.status === "red" ? -1 : 1))
                .map(({ h, client }) => (
                  <li key={h.id}>
                    <Link href={`/clients/${h.clientId}`} className="group flex items-center gap-3 py-2.5">
                      <ClientLogo name={client} size={30} className="rounded-lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-white group-hover:text-brand-light">{client}</span>
                        <span className="block truncate text-xs text-muted">{h.issue}</span>
                      </span>
                      <HealthDot status={h.status} label={h.status} />
                    </Link>
                  </li>
                ))}
            </List>
          ) : (
            <Empty icon="pulse" compact>
              Every client is green.
            </Empty>
          )}
        </Card>
        <Card title="Tasks due" actions={<CardLink href="/tasks">Board</CardLink>}>
          {dueTasks.length ? (
            <List>
              {dueTasks.map(({ t, client }) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-white">{t.title}</span>
                    <span className="block truncate text-xs text-muted">{[client, t.assignee].filter(Boolean).join(" · ") || "No client"}</span>
                  </span>
                  <DueChip date={t.dueDate} today={t0} />
                </li>
              ))}
            </List>
          ) : (
            <Empty icon="check" compact>
              Nothing due.
            </Empty>
          )}
        </Card>
        <Card title="Waiting on you">
          <ul className="space-y-2">
            {[
              { href: "/approvals", icon: "shield" as const, label: "Approvals waiting", value: pending.length },
              { href: "/agents", icon: "spark" as const, label: "Agent runs failed, 7 days", value: failedRuns },
              ...(revenue ? [{ href: "/payments?view=month#aging", icon: "alert" as const, label: `Overdue payments · ${eur(revenue.overdueTotal)}`, value: revenue.overdueCount }] : []),
            ].map((r) => (
              <li key={r.href}>
                <Link href={r.href} className="group flex items-center gap-3 rounded-xl border border-line bg-canvas/50 px-3 py-2.5 transition-colors hover:border-brand/40">
                  <Icon name={r.icon} className="size-4 text-brand-light" />
                  <span className="flex-1 text-sm text-soft group-hover:text-white">{r.label}</span>
                  <span className={`num text-sm font-semibold ${r.value ? "text-amber-300" : "text-white"}`}>{r.value}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** Circular 0–100 score. */
function ScoreRing({ score }: { score: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? "#34d399" : score >= 70 ? "#38c4fa" : score >= 50 ? "#fbbf24" : "#f87171";
  return (
    <span className="relative grid size-12 shrink-0 place-items-center" role="img" aria-label={`Score ${score} out of 100`}>
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="22" cy="22" r={r} fill="none" stroke="#13284a" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      </svg>
      <span className="num text-sm font-bold text-white">{score}</span>
    </span>
  );
}

/** Revenue this year, MRR and overdue, loaded only for people allowed to see money. */
async function revenueFigures(yearStart: string) {
  const month = monthStart();
  const [m, late, byPeriod] = await Promise.all([
    mrr(),
    overdue(),
    db
      .select({
        period: schema.payments.period,
        billed: sql<string>`sum(${schema.payments.amountDue})`,
        collected: sql<string>`sum(${schema.payments.amountCollected})`,
      })
      .from(schema.payments)
      .where(and(gte(schema.payments.period, yearStart), lte(schema.payments.period, month)))
      .groupBy(schema.payments.period)
      .orderBy(schema.payments.period),
  ]);
  const months = byPeriod.map((r) => ({ period: r.period, billed: round2(Number(r.billed)), collected: round2(Number(r.collected)) }));
  const billed = round2(months.reduce((s, x) => s + x.billed, 0));
  const collected = round2(months.reduce((s, x) => s + x.collected, 0));
  const best = months.reduce<(typeof months)[number] | null>((b, x) => (!b || x.collected > b.collected ? x : b), null);
  return {
    months,
    billed,
    collected,
    rate: billed ? Math.round((collected / billed) * 100) : 0,
    thisMonth: months.find((x) => x.period === month)?.collected ?? 0,
    lastMonth: months.find((x) => x.period === addMonths(month, -1))?.collected ?? 0,
    best,
    mrr: m.exVat,
    mrrClients: m.clients,
    overdueTotal: round2(late.reduce((s, r) => s + r.owed, 0)),
    overdueCount: late.length,
  };
}
