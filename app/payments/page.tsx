import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { paymentState, round2 } from "@/lib/billing";
import { addMonths, eur, monthLabel, monthStart, today } from "@/lib/dates";
import { AGING_BUCKETS, SUGGEST_AT } from "@/lib/matching";
import { latestCashSummary, receivables } from "@/lib/finance";
import { listUnmatched, openRows } from "@/lib/reconcile";
import { BANK_FORMATS } from "@/lib/bank-csv";
import {
  addPaymentAction,
  assignIncomingAction,
  generateMonthAction,
  ignoreIncomingAction,
  importBankCsvAction,
  recordPaymentAction,
  saveCashSummaryAction,
} from "../actions";
import { Badge, Card, Empty, PageHeader, Stat, Table, btn, btnGhost, field, input } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = { paid: "green", part: "yellow", overdue: "red", due: "yellow", upcoming: "gray" };
const BUCKET_TONE: Record<string, "bad" | undefined> = { "31-60": "bad", "60+": "bad" };

const shortMonth = (period: string) => monthLabel(period).replace(/^(\w{3})\w*/, "$1");

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ month?: string; imported?: string; error?: string }> }) {
  const sp = await searchParams;
  const period = monthStart(/^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : today());
  const month = period.slice(0, 7);
  const [rows, clients, unmatched, open, rec, summary, recent] = await Promise.all([
    db
      .select({ p: schema.payments, client: schema.clients })
      .from(schema.payments)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
      .where(eq(schema.payments.period, period))
      .orderBy(asc(schema.clients.name)),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(schema.clients.name),
    listUnmatched(),
    openRows(),
    receivables(),
    latestCashSummary(),
    db
      .select({ i: schema.incomingPayments, client: schema.clients.name })
      .from(schema.incomingPayments)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.incomingPayments.clientId))
      .where(eq(schema.incomingPayments.status, "matched"))
      .orderBy(desc(schema.incomingPayments.decidedAt))
      .limit(6),
  ]);
  const due = round2(rows.reduce((s, r) => s + r.p.amountDue, 0));
  const collected = round2(rows.reduce((s, r) => s + r.p.amountCollected, 0));
  const rowLabel = (r: (typeof open)[number]) => `${r.clientName} · ${shortMonth(r.period)}${r.label && r.label !== "Retainer" ? ` ${r.label}` : ""} · ${eur(round2(r.amountDue - r.amountCollected))}`;

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

      {sp.imported && <p className="mb-4 rounded-xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm">{sp.imported}</p>}
      {sp.error && <p className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{sp.error}</p>}

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
                    {p.notes && <div className="mt-1 max-w-56 text-xs whitespace-pre-line text-ink/50">{p.notes}</div>}
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

      <div id="reconcile" className="mt-6 scroll-mt-6">
        <Card
          title={`Unmatched payments${unmatched.length ? ` (${unmatched.length})` : ""}`}
          actions={<span className="text-xs text-ink/50">Stripe payments that didn&rsquo;t match a client, and bank credits waiting for you to confirm</span>}
        >
          <form action={importBankCsvAction} className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3">
            <input type="hidden" name="month" value={month} />
            <span className="text-sm font-medium">Bank CSV</span>
            <input type="file" name="file" accept=".csv,text/csv" required className="text-sm text-ink/70 file:mr-3 file:rounded-full file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm file:text-ink" />
            <select name="format" defaultValue="" className={`${field} w-44`} aria-label="Bank format">
              <option value="">Detect format</option>
              {BANK_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <SubmitButton className={btn} pendingText="Reading…">
              Upload
            </SubmitButton>
            <span className="text-xs text-ink/50">Only money in is read. Matches are suggested; nothing is recorded until you confirm.</span>
          </form>

          {unmatched.length ? (
            <Table head={["Received", "From / reference", "Amount", "Match to", ""]}>
              {unmatched.map((u) => {
                const top = u.live[0];
                const suggested = top && top.score >= SUGGEST_AT ? top : undefined;
                const others = open.filter((r) => !u.live.some((s) => s.paymentId === r.id));
                return (
                  <tr key={u.id} className="align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {u.receivedDate}
                      <div className="mt-1">
                        <Badge tone={u.source === "stripe" ? "brand" : "gray"}>{u.source === "stripe" ? "stripe" : (u.bankFormat ?? "bank")}</Badge>
                      </div>
                    </td>
                    <td className="max-w-72 px-4 py-2.5">
                      <div className="font-medium">{u.payer ?? "Unknown payer"}</div>
                      <div className="text-xs break-words text-ink/60">{[u.reference, u.description].filter(Boolean).join(" · ")}</div>
                      {u.notes && <div className="mt-1 text-xs text-amber-300/80">{u.notes}</div>}
                    </td>
                    <td className="num px-4 py-2.5 whitespace-nowrap">
                      {eur(u.remaining)}
                      {u.allocated > 0 && <div className="text-xs text-ink/50">of {eur(u.amount)}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <form action={assignIncomingAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="month" value={month} />
                        <input type="hidden" name="incomingId" value={u.id} />
                        <select name="paymentId" required defaultValue={suggested?.paymentId ?? ""} className={`${field} w-80 max-w-full`} aria-label="Payment row">
                          <option value="" disabled>
                            Choose a payment row…
                          </option>
                          {u.live.length > 0 && (
                            <optgroup label="Likely matches">
                              {u.live.map((s) => (
                                <option key={s.paymentId} value={s.paymentId}>
                                  {rowLabel(s.row)} (score {s.score})
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="Other open rows">
                            {others.map((r) => (
                              <option key={r.id} value={r.id}>
                                {rowLabel(r)}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <SubmitButton className={suggested ? btn : btnGhost} pendingText="…">
                          {suggested ? "Confirm" : "Assign"}
                        </SubmitButton>
                        {u.source === "stripe" && u.stripeCustomerId && (
                          <label className="flex w-full items-center gap-1.5 text-xs text-ink/60">
                            <input type="checkbox" name="linkStripe" defaultChecked /> Save {u.stripeCustomerId} on the client
                          </label>
                        )}
                      </form>
                      {suggested ? (
                        <p className="mt-1 text-xs text-ink/50">
                          Suggested: {suggested.row.clientName}, {monthLabel(suggested.row.period)}. {suggested.reasons.join(", ")}.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-ink/50">No confident match. Pick the row by hand.</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {u.allocated === 0 && (
                        <form action={ignoreIncomingAction}>
                          <input type="hidden" name="month" value={month} />
                          <input type="hidden" name="incomingId" value={u.id} />
                          <SubmitButton className="text-xs text-ink/50 underline hover:text-ink" pendingText="…">
                            Not a client payment
                          </SubmitButton>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <Empty>Nothing to match. Every Stripe payment found its client, and no bank credits are waiting.</Empty>
          )}

          {recent.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-2 text-xs font-medium tracking-wide text-ink/50 uppercase">Recently reconciled</h3>
              <ul className="space-y-1 text-sm">
                {recent.map(({ i, client }) => (
                  <li key={i.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {i.receivedDate} · {client ?? i.payer ?? "–"} · <span className="text-ink/50">{i.source === "stripe" ? "Stripe" : i.bankFormat}</span>
                    </span>
                    <span className="num text-ink/70">
                      {eur(i.amount)} <span className="text-xs text-ink/40">({i.matchedBy})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Overdue by age" actions={<span className="num text-sm font-medium">{eur(rec.total)} owed</span>}>
          <div className="grid grid-cols-2 gap-3">
            {AGING_BUCKETS.map((b) => (
              <Stat
                key={b.key}
                label={b.label}
                value={eur(rec.totals[b.key])}
                hint={`${rec.counts[b.key]} row${rec.counts[b.key] === 1 ? "" : "s"}`}
                tone={rec.totals[b.key] > 0 ? BUCKET_TONE[b.key] : undefined}
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-ink/50">Days past the due date, across all months, as of {rec.asOf}.</p>
        </Card>

        <Card title="Balance by client">
          {rec.clients.length ? (
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs tracking-wide text-ink/50 uppercase">
                    <th className="px-4 py-2 font-medium">Client</th>
                    <th className="px-4 py-2 font-medium">Balance</th>
                    <th className="px-4 py-2 font-medium">Oldest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
              {rec.clients.map((c) => (
                <tr key={c.clientId}>
                  <td className="px-4 py-2">
                    <Link href={`/clients/${c.clientId}`} className="font-medium hover:underline">
                      {c.clientName}
                    </Link>
                    <div className="text-xs text-ink/50">
                      {c.rows} row{c.rows === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="num px-4 py-2">{eur(c.balance)}</td>
                  <td className="px-4 py-2">
                    <Badge tone={c.oldestDays > 30 ? "red" : c.oldestDays > 14 ? "yellow" : "gray"}>{c.oldestDays} days</Badge>
                    <div className="mt-1 text-xs text-ink/50">
                      {c.chasersQueued.length ? `${c.chasersQueued.map((s) => `${s}-day`).join(", ")} chaser queued` : c.chaserDue ? `${c.chaserDue}-day chaser due` : ""}
                    </div>
                  </td>
                </tr>
              ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Nobody owes anything that&rsquo;s due.</Empty>
          )}
        </Card>
      </div>

      <div id="cash-summary" className="mt-6 scroll-mt-6">
        <Card
          title="Cash summary"
          actions={
            <form action={saveCashSummaryAction} className="flex items-center gap-2">
              <input type="hidden" name="month" value={month} />
              {summary && (
                <span className="text-xs text-ink/50">
                  {summary.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", dateStyle: "medium", timeStyle: "short" })}
                  {summary.postedToSlack ? " · posted to Slack" : ""}
                </span>
              )}
              <SubmitButton className={btnGhost} pendingText="Building…">
                Build now
              </SubmitButton>
            </form>
          }
        >
          {summary ? (
            <pre className="font-sans text-sm whitespace-pre-wrap text-ink/80">{summary.body}</pre>
          ) : (
            <Empty>The finance agent saves a cash summary every Friday. Build one now to see it here.</Empty>
          )}
        </Card>
      </div>

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
