import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { paymentState, round2 } from "@/lib/billing";
import { addMonths, eur, monthLabel, monthStart, today } from "@/lib/dates";
import { addPaymentAction, generateMonthAction, recordPaymentAction } from "../actions";
import { Badge, Card, Empty, PageHeader, Stat, Table, btn, btnGhost, field, input } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = { paid: "green", part: "yellow", overdue: "red", due: "yellow", upcoming: "gray" };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const period = monthStart(/^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : today());
  const month = period.slice(0, 7);
  const [rows, clients] = await Promise.all([
    db
      .select({ p: schema.payments, client: schema.clients })
      .from(schema.payments)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
      .where(eq(schema.payments.period, period))
      .orderBy(asc(schema.clients.name)),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(schema.clients.name),
  ]);
  const due = round2(rows.reduce((s, r) => s + r.p.amountDue, 0));
  const collected = round2(rows.reduce((s, r) => s + r.p.amountCollected, 0));

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle={monthLabel(period)}
        actions={
          <>
            <Link className={btnGhost} href={`/payments?month=${addMonths(period, -1).slice(0, 7)}`}>
              ← Prev
            </Link>
            <Link className={btnGhost} href={`/payments?month=${addMonths(period, 1).slice(0, 7)}`}>
              Next →
            </Link>
            <form action={generateMonthAction}>
              <input type="hidden" name="month" value={month} />
              <SubmitButton className={btn}>Generate {monthLabel(period).split(" ")[0]} rows</SubmitButton>
            </form>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Due" value={eur(due)} />
        <Stat label="Collected" value={eur(collected)} tone="good" />
        <Stat label="Outstanding" value={eur(round2(due - collected))} tone={due - collected > 0 ? "bad" : undefined} />
      </div>

      <Card>
        {rows.length ? (
          <Table head={["Client", "Line", "Due", "Collected", "Status", "Record payment"]}>
            {rows.map(({ p, client }) => {
              const s = paymentState(p);
              return (
                <tr key={p.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <Link href={`/clients/${client.id}`} className="font-medium hover:underline">
                      {client.name}
                    </Link>
                    <div className="text-xs text-ink/50">{p.method ?? client.billingMethod}</div>
                  </td>
                  <td className="px-4 py-2.5 text-ink/70">{p.label}</td>
                  <td className="num px-4 py-2.5">{eur(p.amountDue)}</td>
                  <td className="num px-4 py-2.5">
                    {eur(p.amountCollected)}
                    {p.paidDate && <div className="text-xs text-ink/50">{p.paidDate}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATE_TONE[s]}>{s}</Badge>
                    {p.notes && <div className="mt-1 max-w-48 text-xs whitespace-pre-line text-ink/50">{p.notes}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    {s !== "paid" && (
                      <form action={recordPaymentAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input name="amount" defaultValue={p.amountDue} className={`${field} num w-24`} aria-label="Total collected" />
                        <select name="method" defaultValue={p.method ?? client.billingMethod} className={`${field} w-28`} aria-label="Method">
                          {["stripe", "invoice", "revolut", "aib", "cash"].map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                        <SubmitButton className={btnGhost} pendingText="…">
                          Paid
                        </SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>No payment rows for {monthLabel(period)} yet. Click &ldquo;Generate&rdquo; to create one per active client from their retainer.</Empty>
        )}
      </Card>

      <Card title="Add a one-off charge" className="mt-6">
        <form action={addPaymentAction} className="grid gap-3 sm:grid-cols-5">
          <input type="hidden" name="month" value={month} />
          <select name="clientId" required className={input} aria-label="Client">
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input name="label" placeholder="What for, e.g. Website build" required className={`${input} sm:col-span-2`} />
          <input name="amountDue" placeholder="Amount incl. VAT" required className={`${input} num`} />
          <SubmitButton className={btn}>Add</SubmitButton>
        </form>
      </Card>
    </>
  );
}
