import Link from "next/link";
import { desc, eq, ne, and, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { mrr, monthTotals, overdue } from "@/lib/billing";
import { eur, monthLabel, monthStart, today, weekStart } from "@/lib/dates";
import { Badge, Card, Empty, PageHeader, Stat } from "./_components/ui";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const month = monthStart();
  const [m, totals, late, pending, health, dueTasks, runs] = await Promise.all([
    mrr(),
    monthTotals(month),
    overdue(),
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
      .limit(8),
    db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(5),
  ]);
  const lateTotal = late.reduce((s, r) => s + r.owed, 0);
  const collectedPct = totals.due ? Math.round((totals.collected / totals.due) * 100) : 0;

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${monthLabel(month)} · today ${today()}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="MRR (ex VAT)" value={eur(m.exVat)} hint={`${m.clients} active clients`} />
        <Stat label="Collected this month" value={eur(totals.collected)} hint={`${collectedPct}% of ${eur(totals.due)}`} tone="good" />
        <Stat label="Outstanding this month" value={eur(totals.outstanding)} hint={totals.count ? `${totals.count} invoices` : "No rows yet: generate the month in Payments"} />
        <Stat label="Overdue (all time)" value={eur(lateTotal)} hint={`${late.length} payments`} tone={lateTotal > 0 ? "bad" : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Needs your OK" actions={<Link href="/approvals" className="text-xs text-brand">All approvals →</Link>}>
          {pending.length ? (
            <ul className="divide-y divide-black/5 text-sm">
              {pending.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="truncate">
                    <span className="font-medium">{a.agent}</span> · {a.tool}
                  </span>
                  <Badge tone="yellow">pending</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing waiting.</Empty>
          )}
        </Card>

        <Card title="Clients needing attention this week" actions={<Link href="/health" className="text-xs text-brand">Client health →</Link>}>
          {health.length ? (
            <ul className="divide-y divide-black/5 text-sm">
              {health.map(({ h, client }) => (
                <li key={h.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{client}</span>
                    <Badge tone={h.status}>{h.status}</Badge>
                  </div>
                  {h.actionNeeded && <p className="mt-0.5 text-black/60">{h.actionNeeded}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No red or yellow clients this week.</Empty>
          )}
        </Card>

        <Card title="Overdue payments" actions={<Link href="/payments" className="text-xs text-brand">Payments →</Link>}>
          {late.length ? (
            <ul className="divide-y divide-black/5 text-sm">
              {late.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{p.client}</span> <span className="text-black/50">· {monthLabel(p.period)}</span>
                  </span>
                  <span className="num shrink-0 whitespace-nowrap">
                    {eur(p.owed)} <span className="text-xs text-red-600">{p.days}d</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing overdue.</Empty>
          )}
        </Card>

        <Card title="Tasks due" actions={<Link href="/tasks" className="text-xs text-brand">Tasks →</Link>}>
          {dueTasks.length ? (
            <ul className="divide-y divide-black/5 text-sm">
              {dueTasks.map(({ t, client }) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate">
                    {t.title} {client && <span className="text-black/50">· {client}</span>}
                  </span>
                  <span className="num shrink-0 text-xs whitespace-nowrap text-black/50">{t.dueDate}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing due.</Empty>
          )}
        </Card>
      </div>

      <Card title="Recent agent runs" className="mt-6" actions={<Link href="/agents" className="text-xs text-brand">Agents →</Link>}>
        {runs.length ? (
          <ul className="divide-y divide-black/5 text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <Link href={`/agents/runs/${r.id}`} className="truncate hover:underline">
                  <span className="font-medium">{r.agent}</span> <span className="text-black/50">· {r.startedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}</span>
                </Link>
                <Badge tone={r.status === "completed" ? "green" : r.status === "running" ? "blue" : r.status === "error" ? "red" : "yellow"}>{r.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No runs yet.</Empty>
        )}
      </Card>
    </>
  );
}

