import Link from "next/link";
import { desc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { eur, weekStart } from "@/lib/dates";
import { resolveHealth, saveHealthAction } from "../actions";
import { Badge, Card, Empty, PageHeader, Table, btn, input } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

const ISSUES = ["Everything Healthy", "Campaign Learning", "Client Concern", "Budget Issue", "Tracking Issue", "Poor Lead Quality", "Creative Fatigue", "Lead Volume Down", "CPL Rising", "Leads Not Worked"];

export default async function HealthPage() {
  const since = new Date(Date.now() - 6 * 7 * 86_400_000).toISOString().slice(0, 10);
  const [rows, clients] = await Promise.all([
    db
      .select({ h: schema.healthChecks, client: schema.clients })
      .from(schema.healthChecks)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
      .where(gte(schema.healthChecks.weekOf, since))
      .orderBy(desc(schema.healthChecks.weekOf), schema.clients.name),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.status, "active")).orderBy(schema.clients.name),
  ]);
  const thisWeek = weekStart();
  const current = rows.filter((r) => r.h.weekOf === thisWeek);
  const order = { red: 0, yellow: 1, green: 2 } as const;
  current.sort((a, b) => order[a.h.status] - order[b.h.status]);

  return (
    <>
      <PageHeader title="Client health" subtitle={`Week of ${thisWeek} · the client-health agent fills this in each weekday morning`} />

      <Card title="This week">
        {current.length ? (
          <Table head={["Client", "Status", "CPL / target", "Issue", "Reason", "Action", ""]}>
            {current.map(({ h, client }) => (
              <tr key={h.id} className="align-top">
                <td className="px-4 py-2.5 font-medium">
                  <Link href={`/clients/${client.id}`} className="hover:underline">
                    {client.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={h.status}>{h.status}</Badge>
                </td>
                <td className="num px-4 py-2.5">
                  {eur(h.cpl, client.reportCurrency)} <span className="text-black/40">/ {eur(client.cplTarget, client.reportCurrency)}</span>
                </td>
                <td className="px-4 py-2.5">{h.issue}</td>
                <td className="max-w-64 px-4 py-2.5 text-black/70">{h.reason}</td>
                <td className="max-w-64 px-4 py-2.5">{h.actionNeeded}</td>
                <td className="px-4 py-2.5">
                  {h.resolved ? (
                    <Badge tone="green">resolved</Badge>
                  ) : h.status !== "green" ? (
                    <form action={resolveHealth.bind(null, h.id)}>
                      <button className="rounded border border-black/10 px-2 py-0.5 text-xs hover:bg-black/5">Resolve</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No checks this week yet.</Empty>
        )}
      </Card>

      <Card title="Log a check by hand" className="mt-6">
        <form action={saveHealthAction} className="grid gap-3 sm:grid-cols-6">
          <select name="clientId" required className={input} aria-label="Client">
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="status" className={input} aria-label="Status">
            <option value="green">Green</option>
            <option value="yellow">Yellow</option>
            <option value="red">Red</option>
          </select>
          <select name="issue" className={input} aria-label="Issue">
            {ISSUES.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
          <input name="cpl" placeholder="CPL" className={`${input} num`} />
          <input name="reason" placeholder="Reason" className={input} />
          <input name="actionNeeded" placeholder="Action needed" className={input} />
          <div className="sm:col-span-6">
            <SubmitButton className={btn}>Save</SubmitButton>
          </div>
        </form>
      </Card>

      <Card title="Last 6 weeks" className="mt-6">
        {rows.length ? (
          <div className="-mx-4 overflow-x-auto">
            <HistoryGrid rows={rows.map((r) => ({ client: r.client.name, week: r.h.weekOf, status: r.h.status }))} />
          </div>
        ) : (
          <Empty>No history yet.</Empty>
        )}
      </Card>
    </>
  );
}

function HistoryGrid({ rows }: { rows: { client: string; week: string; status: "green" | "yellow" | "red" }[] }) {
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const clients = [...new Set(rows.map((r) => r.client))].sort();
  const cell = new Map(rows.map((r) => [`${r.client}|${r.week}`, r.status]));
  const color = { green: "bg-emerald-500", yellow: "bg-amber-400", red: "bg-red-500" };
  return (
    <table className="text-sm">
      <thead>
        <tr className="text-xs text-black/50">
          <th className="px-4 py-1 text-left font-medium">Client</th>
          {weeks.map((w) => (
            <th key={w} className="px-2 py-1 font-medium">
              {w.slice(5)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {clients.map((c) => (
          <tr key={c}>
            <td className="px-4 py-1 whitespace-nowrap">{c}</td>
            {weeks.map((w) => {
              const s = cell.get(`${c}|${w}`);
              return (
                <td key={w} className="px-2 py-1 text-center">
                  {s ? <span title={s} className={`inline-block size-3 rounded-full ${color[s]}`} /> : <span className="text-black/20">·</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
