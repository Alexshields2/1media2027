import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { paymentState } from "@/lib/billing";
import { eur, monthLabel } from "@/lib/dates";
import { updateClient } from "../../actions";
import { Badge, Card, Empty, PageHeader } from "../../_components/ui";
import { ClientForm } from "../client-form";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = { paid: "green", part: "yellow", overdue: "red", due: "yellow", upcoming: "gray" };

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  if (!client) notFound();

  const [payments, tasks, health, reports] = await Promise.all([
    db.select().from(schema.payments).where(eq(schema.payments.clientId, id)).orderBy(desc(schema.payments.period)).limit(12),
    db.select().from(schema.tasks).where(eq(schema.tasks.clientId, id)).orderBy(desc(schema.tasks.createdAt)).limit(15),
    db.select().from(schema.healthChecks).where(eq(schema.healthChecks.clientId, id)).orderBy(desc(schema.healthChecks.weekOf)).limit(8),
    db.select().from(schema.reports).where(eq(schema.reports.clientId, id)).orderBy(desc(schema.reports.createdAt)).limit(8),
  ]);

  return (
    <>
      <PageHeader title={client.name} subtitle={<Link href="/clients" className="hover:underline">← All clients</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Details">
            <ClientForm client={client} action={updateClient.bind(null, id)} submitLabel="Save changes" />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Payments">
            {payments.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {payments.map((p) => {
                  const s = paymentState(p);
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {monthLabel(p.period)} <span className="text-ink/50">{p.label !== "Retainer" ? `· ${p.label}` : ""}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="num">{eur(p.amountDue)}</span>
                        <Badge tone={STATE_TONE[s]}>{s}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>No payments yet.</Empty>
            )}
          </Card>
          <Card title="Health">
            {health.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {health.map((h) => (
                  <li key={h.id} className="py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-ink/60">Week of {h.weekOf}</span>
                      <Badge tone={h.status}>{h.status}</Badge>
                    </div>
                    {h.reason && <p className="mt-0.5 text-ink/70">{h.reason}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No health checks yet.</Empty>
            )}
          </Card>
          <Card title="Tasks">
            {tasks.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <span className={t.status === "done" ? "text-ink/40 line-through" : ""}>{t.title}</span>
                    <span className="text-xs text-ink/50">{t.dueDate}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No tasks.</Empty>
            )}
          </Card>
          <Card title="Reports">
            {reports.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <Link href={`/reports#r${r.id}`} className="hover:underline">
                      {r.kind === "weekly" ? "Weekly" : "Monthly"} · {r.period}
                    </Link>
                    <Badge tone={r.status === "sent" ? "green" : "yellow"}>{r.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No reports yet.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
