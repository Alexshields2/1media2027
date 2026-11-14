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
import { can } from "@/lib/roles";
import { Badge, Card, Empty, NoAccess, Notice, PageHeader, Progress, Segmented, Table, btn, btnGhost, btnLink, btnSm, field, input, td, tdNum } from "../_components/ui";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { requireUser } from "@/lib/session";
import { assignTargets, bankCreditsWaiting, loadPaymentLog } from "@/lib/payment-log";
import { PaymentLog, StripeToAssign, type ToAssign } from "./payment-log";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = { paid: "green", part: "yellow", overdue: "red", due: "yellow", upcoming: "gray" };
const STATE_LABEL: Record<string, string> = { paid: "Paid", part: "Part paid", overdue: "Overdue", due: "Due today", upcoming: "Upcoming" };
const BUCKET_COLOR: Record<string, string> = { "0-14": "bg-brand-light", "15-30": "bg-amber-400", "31-60": "bg-orange-500", "60+": "bg-red-500" };
const BUCKET_TONE: Record<string, "bad" | undefined> = { "31-60": "bad", "60+": "bad" };

const shortMonth = (period: string) => monthLabel(period).replace(/^(\w{3})\w*/, "$1");

type Search = { view?: string; year?: string; month?: string; imported?: string; error?: string };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!can(user.role, "payments")) return <NoAccess what="Payments" />;
  const sp = await searchParams;
  // The payment log is the default; links with ?month= (and the reconcile redirects) still open the month view.
  const view = sp.view === "list" || sp.view === "month" || sp.view === "log" ? sp.view : sp.month || sp.imported || sp.error ? "month" : "log";
  if (view === "month") return <MonthView sp={sp} />;
  return <LogView sp={sp} mode={view === "list" ? "list" : "grid"} />;
}

function ViewSwitch({ view, year, month }: { view: "log" | "list" | "month"; year: number; month?: string }) {
  return (
    <Segmented
      label="Payments view"
      items={[
        { href: `/payments?view=log&year=${year}`, label: "Log", icon: "grid", active: view === "log" },
        { href: `/payments?view=list&year=${year}`, label: "By month", icon: "list", active: view === "list" },
        { href: `/payments?view=month${month ? `&month=${month}` : ""}`, label: "Month view", icon: "calendar", active: view === "month" },
      ]}
    />
  );
}

async function LogView({ sp, mode }: { sp: Search; mode: "grid" | "list" }) {
  const on = today();
  const year = /^\d{4}$/.test(sp.year ?? "") ? Number(sp.year) : Number(on.slice(0, 4));
  const [log, unmatched, targets, bankWaiting] = await Promise.all([loadPaymentLog(year, on), listUnmatched(), assignTargets(on), bankCreditsWaiting()]);
  const rows = log.lines.flatMap((l) => Object.values(l.cells).filter((r): r is NonNullable<typeof r> => !!r));
  const clients = [...new Map(log.lines.map((l) => [l.client.id, l.client])).values()];
  const stripe: ToAssign[] = unmatched
    .filter((u) => u.source === "stripe")
    .map((u) => ({
      id: u.id,
      receivedDate: u.receivedDate,
      amount: u.amount,
      remaining: u.remaining,
      payer: u.payer,
      reference: u.reference,
      description: u.description,
      notes: u.notes,
      clientId: u.clientId,
      stripeCustomerId: u.stripeCustomerId,
      suggested: u.live
        .filter((s) => (u.clientId ? s.row.clientId === u.clientId : s.score >= SUGGEST_AT))
        .map((s) => ({ paymentId: s.paymentId, clientId: s.row.clientId, period: s.row.period, label: s.row.label ?? "Retainer", reasons: s.reasons })),
    }));
  const yearNav = (y: number) => `/payments?view=${mode === "grid" ? "log" : "list"}&year=${y}`;
  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Tick off each client's month as it's paid. Stripe payments wait for you to say which month they cover."
        actions={<ViewSwitch view={mode === "grid" ? "log" : "list"} year={year} />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link aria-disabled={!log.years.includes(year - 1)} className={`grid size-10 place-items-center rounded-full border border-line bg-panel text-soft hover:border-brand/50 hover:text-white ${log.years.includes(year - 1) ? "" : "pointer-events-none opacity-40"}`} href={yearNav(year - 1)} aria-label="Previous year">
          <Icon name="chevronLeft" />
        </Link>
        <h2 className="min-w-16 text-center text-lg font-semibold text-white">{year}</h2>
        <Link aria-disabled={!log.years.includes(year + 1)} className={`grid size-10 place-items-center rounded-full border border-line bg-panel text-soft hover:border-brand/50 hover:text-white ${log.years.includes(year + 1) ? "" : "pointer-events-none opacity-40"}`} href={yearNav(year + 1)} aria-label="Next year">
          <Icon name="chevronRight" />
        </Link>
        {bankWaiting > 0 && (
          <Link href="/payments?view=month#reconcile" className={`${btnLink} ml-auto`}>
            {bankWaiting} bank credit{bankWaiting === 1 ? "" : "s"} to match →
          </Link>
        )}
      </div>
      <StripeToAssign items={stripe} clients={targets} />
      <PaymentLog mode={mode} year={year} years={log.years} today={on} clients={clients} rows={rows} />
    </>
  );
}

async function MonthView({ sp }: { sp: Search }) {
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

  const outstanding = round2(due - collected);
  const states = rows.map(({ p }) => paymentState(p));
  const nPaid = states.filter((x) => x === "paid").length;
  const nLate = states.filter((x) => x === "overdue").length;
  const nPart = states.filter((x) => x === "part").length;
  const agingMax = Math.max(rec.total, 0.01);

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Retainers per month, money in from Stripe and the bank, and who owes what."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ViewSwitch view="month" year={Number(month.slice(0, 4))} month={month} />
            <form action={generateMonthAction}>
              <input type="hidden" name="month" value={month} />
              <SubmitButton className={btnGhost}>
                <Icon name="plus" /> Generate {monthLabel(period).split(" ")[0]} rows
              </SubmitButton>
            </form>
          </div>
        }
      />

      {sp.imported && <Notice tone="info">{sp.imported}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}

      {/* Month header: navigation, collected vs outstanding */}
      <section className="surface relative mb-6 overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_0%_0%,rgb(4_153_242/0.16),transparent_60%)]" />
        <div className="relative p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Link className="grid size-9 place-items-center rounded-full border border-line bg-canvas/60 text-soft hover:border-brand/50 hover:text-white" href={`/payments?view=month&month=${addMonths(period, -1).slice(0, 7)}`} aria-label="Previous month">
                <Icon name="chevronLeft" />
              </Link>
              <h2 className="min-w-40 text-center text-lg font-semibold text-white">{monthLabel(period)}</h2>
              <Link className="grid size-9 place-items-center rounded-full border border-line bg-canvas/60 text-soft hover:border-brand/50 hover:text-white" href={`/payments?view=month&month=${addMonths(period, 1).slice(0, 7)}`} aria-label="Next month">
                <Icon name="chevronRight" />
              </Link>
              {period !== monthStart() && (
                <Link href="/payments?view=month" className={`${btnLink} ml-1`}>
                  This month
                </Link>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="green" dot>{nPaid} paid</Badge>
              {nPart > 0 && <Badge tone="yellow" dot>{nPart} part paid</Badge>}
              {nLate > 0 && <Badge tone="red" dot>{nLate} overdue</Badge>}
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-3">
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Collected</div>
              <div className="num mt-1 text-2xl font-semibold tracking-tight sm:text-3xl text-emerald-300">{eur(collected)}</div>
              <div className="mt-0.5 text-xs text-muted">{due ? Math.round((collected / due) * 100) : 0}% of the month</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Outstanding</div>
              <div className={`num mt-1 text-2xl font-semibold tracking-tight sm:text-3xl ${outstanding > 0 ? "text-white" : "text-emerald-300"}`}>{eur(outstanding)}</div>
              <div className="mt-0.5 text-xs text-muted">{rows.length - nPaid} of {rows.length} rows open</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Billed</div>
              <div className="num mt-1 text-2xl font-semibold tracking-tight sm:text-3xl text-white">{eur(due)}</div>
              <div className="mt-0.5 text-xs text-muted">incl. VAT</div>
            </div>
          </div>
          <Progress value={collected} max={due} tone="green" label={`Collected for ${monthLabel(period)}`} className="mt-6 !h-2.5" />
        </div>
      </section>

      <Card flush title={`${monthLabel(period)} rows`} description="Record what arrived by hand. Stripe payments wait in the log until you assign them to a month.">
        {rows.length ? (
          <Table head={["Client", "Line", { label: "Due", align: "right" }, { label: "Collected", align: "right" }, "Status", "Record payment"]} minWidth={860}>
            {rows.map(({ p, client }) => {
              const s = paymentState(p);
              return (
                <tr key={p.id} className="align-middle">
                  <td className={td}>
                    <Link href={`/clients/${client.id}`} className="group flex items-center gap-3">
                      <ClientLogo name={client.name} size={34} className="rounded-lg" />
                      <span className="min-w-0">
                        <span className="block font-medium whitespace-nowrap text-white group-hover:text-brand-light">{client.name}</span>
                        <span className="block text-xs text-muted capitalize">{p.method ?? client.billingMethod}</span>
                      </span>
                    </Link>
                  </td>
                  <td className={`${td} text-soft`}>{p.label}</td>
                  <td className={tdNum}>{eur(p.amountDue)}</td>
                  <td className={tdNum}>
                    <span className={p.amountCollected > 0 ? "text-white" : "text-muted"}>{eur(p.amountCollected)}</span>
                    {p.paidDate && <div className="text-xs text-muted">{p.paidDate}</div>}
                  </td>
                  <td className={td}>
                    <Badge tone={STATE_TONE[s]} dot>
                      {STATE_LABEL[s]}
                    </Badge>
                    {p.notes && <div className="mt-1 max-w-56 text-xs whitespace-pre-line text-muted">{p.notes}</div>}
                  </td>
                  <td className={td}>
                    {s !== "paid" ? (
                      <form action={recordPaymentAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input name="amount" defaultValue={p.amountDue} className={`${field} num w-24 py-1.5`} aria-label={`Total collected from ${client.name}`} />
                        <select name="method" defaultValue={p.method ?? client.billingMethod} className={`${field} w-28 py-1.5`} aria-label={`Method for ${client.name}`}>
                          {["stripe", "invoice", "revolut", "aib", "cash"].map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                        <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="…">
                          <Icon name="check" className="size-3.5" /> Paid
                        </SubmitButton>
                      </form>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                        <Icon name="check" className="size-3.5" /> Settled
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty
            icon="euro"
            title={`No rows for ${monthLabel(period)} yet`}
            action={
              <form action={generateMonthAction}>
                <input type="hidden" name="month" value={month} />
                <SubmitButton className={btn}>Generate {monthLabel(period).split(" ")[0]} rows</SubmitButton>
              </form>
            }
          >
            Creates one row per active client from their retainer.
          </Empty>
        )}
      </Card>

      <div id="aging" className="mt-6 grid scroll-mt-24 gap-6 lg:grid-cols-5">
        <Card title="Overdue by age" description={`Days past due, across all months, as of ${rec.asOf}`} actions={<span className="num text-sm font-semibold text-white">{eur(rec.total)}</span>} className="lg:col-span-2">
          <div className="flex h-3 overflow-hidden rounded-full bg-ink/[0.07]" role="img" aria-label={AGING_BUCKETS.map((b) => `${b.label}: ${eur(rec.totals[b.key])}`).join(", ")}>
            {AGING_BUCKETS.map((b) => (rec.totals[b.key] > 0 ? <div key={b.key} className={BUCKET_COLOR[b.key]} style={{ width: `${(rec.totals[b.key] / agingMax) * 100}%` }} /> : null))}
          </div>
          <ul className="mt-5 grid grid-cols-2 gap-3">
            {AGING_BUCKETS.map((b) => (
              <li key={b.key} className="rounded-xl border border-line bg-canvas/50 p-3">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className={`size-2 rounded-full ${BUCKET_COLOR[b.key]}`} aria-hidden />
                  {b.label}
                </div>
                <div className={`num mt-1 text-lg font-semibold ${rec.totals[b.key] > 0 && BUCKET_TONE[b.key] ? "text-red-300" : "text-white"}`}>{eur(rec.totals[b.key])}</div>
                <div className="text-[11px] text-muted">
                  {rec.counts[b.key]} row{rec.counts[b.key] === 1 ? "" : "s"}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Balance by client" description="Who owes what, oldest debt first in colour" flush className="lg:col-span-3">
          {rec.clients.length ? (
            <ul className="divide-y divide-line/70">
              {rec.clients.map((c) => (
                <li key={c.clientId} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-ink/[0.025]">
                  <ClientLogo name={c.clientName} size={34} className="rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link href={`/clients/${c.clientId}`} className="truncate font-medium text-white hover:text-brand-light">
                        {c.clientName}
                      </Link>
                      <span className="num shrink-0 font-semibold text-white">{eur(c.balance)}</span>
                    </div>
                    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
                      {AGING_BUCKETS.map((b) => (c.buckets[b.key] > 0 ? <div key={b.key} className={BUCKET_COLOR[b.key]} style={{ width: `${(c.buckets[b.key] / c.balance) * 100}%` }} /> : null))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      <span>
                        {c.rows} row{c.rows === 1 ? "" : "s"} · oldest <span className={c.oldestDays > 30 ? "text-red-300" : c.oldestDays > 14 ? "text-amber-300" : ""}>{c.oldestDays} days</span>
                      </span>
                      {c.chasersQueued.length ? <span>· {c.chasersQueued.map((s) => `${s}-day`).join(", ")} chaser queued</span> : c.chaserDue ? <span className="text-amber-300">· {c.chaserDue}-day chaser due</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="check" title="Nobody owes anything" compact>
              Every row that&rsquo;s due has been paid.
            </Empty>
          )}
        </Card>
      </div>

      <div id="reconcile" className="mt-6 scroll-mt-24">
        <Card
          title={`Unmatched payments${unmatched.length ? ` (${unmatched.length})` : ""}`}
          description="Stripe payments and bank credits waiting for you to say which month they cover"
        >
          <form action={importBankCsvAction} className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-canvas/40 p-4">
            <input type="hidden" name="month" value={month} />
            <span className="flex items-center gap-2 text-sm font-medium whitespace-nowrap text-white">
              <Icon name="upload" className="text-brand-light" /> Bank CSV
            </span>
            <input type="file" name="file" accept=".csv,text/csv" required aria-label="Bank CSV file" className="max-w-full text-sm text-soft file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm file:text-ink" />
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
            <span className="w-full text-xs text-muted">Only money in is read. Matches are suggested; nothing is recorded until you confirm.</span>
          </form>

          {unmatched.length ? (
            <Table head={["Received", "From / reference", "Amount", "Match to", ""]}>
              {unmatched.map((u) => {
                const top = u.live[0];
                const suggested = top && top.score >= SUGGEST_AT ? top : undefined;
                const others = open.filter((r) => !u.live.some((s) => s.paymentId === r.id));
                return (
                  <tr key={u.id} className="align-top">
                    <td className="px-4 py-3 first:pl-5 last:pr-5 whitespace-nowrap">
                      {u.receivedDate}
                      <div className="mt-1">
                        <Badge tone={u.source === "stripe" ? "brand" : "gray"}>{u.source === "stripe" ? "stripe" : (u.bankFormat ?? "bank")}</Badge>
                      </div>
                    </td>
                    <td className="max-w-72 px-4 py-3">
                      <div className="font-medium">{u.payer ?? "Unknown payer"}</div>
                      <div className="text-xs break-words text-soft">{[u.reference, u.description].filter(Boolean).join(" · ")}</div>
                      {u.notes && <div className="mt-1 text-xs text-amber-300/80">{u.notes}</div>}
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap">
                      {eur(u.remaining)}
                      {u.allocated > 0 && <div className="text-xs text-muted">of {eur(u.amount)}</div>}
                    </td>
                    <td className="px-4 py-3 first:pl-5 last:pr-5">
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
                          <label className="flex w-full items-center gap-1.5 text-xs text-soft">
                            <input type="checkbox" name="linkStripe" defaultChecked /> Save {u.stripeCustomerId} on the client
                          </label>
                        )}
                      </form>
                      {suggested ? (
                        <p className="mt-1 text-xs text-muted">
                          Suggested: {suggested.row.clientName}, {monthLabel(suggested.row.period)}. {suggested.reasons.join(", ")}.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted">No confident match. Pick the row by hand.</p>
                      )}
                    </td>
                    <td className="px-4 py-3 first:pl-5 last:pr-5">
                      {u.allocated === 0 && (
                        <form action={ignoreIncomingAction}>
                          <input type="hidden" name="month" value={month} />
                          <input type="hidden" name="incomingId" value={u.id} />
                          <SubmitButton className="text-xs text-muted underline hover:text-ink" pendingText="…">
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
            <Empty icon="check" title="Nothing to match" compact>
              No Stripe payments or bank credits are waiting.
            </Empty>
          )}

          {recent.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Recently reconciled</h3>
              <ul className="space-y-1 text-sm">
                {recent.map(({ i, client }) => (
                  <li key={i.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {i.receivedDate} · {client ?? i.payer ?? "–"} · <span className="text-muted">{i.source === "stripe" ? "Stripe" : i.bankFormat}</span>
                    </span>
                    <span className="num text-soft">
                      {eur(i.amount)} <span className="text-xs text-muted">({i.matchedBy})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div id="cash-summary" className="mt-6 scroll-mt-24">
        <Card
          title="Cash summary"
          actions={
            <form action={saveCashSummaryAction} className="flex items-center gap-2">
              <input type="hidden" name="month" value={month} />
              {summary && (
                <span className="text-xs text-muted">
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
            <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap text-soft">{summary.body}</pre>
          ) : (
            <Empty icon="doc" title="No cash summary yet" compact>
              The finance agent saves one every Friday. Build one now to see it here.
            </Empty>
          )}
        </Card>
      </div>

      <Card title="Add a one-off charge" description={`Added to ${monthLabel(period)}`} className="mt-6">
        <form action={addPaymentAction} className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr_auto] sm:items-end">
          <input type="hidden" name="month" value={month} />
          <select name="clientId" required className={input} aria-label="Client">
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input name="label" placeholder="What for, e.g. Website build" required className={input} aria-label="What for" />
          <input name="amountDue" placeholder="Amount incl. VAT" required inputMode="decimal" className={`${input} num`} aria-label="Amount incl. VAT" />
          <SubmitButton className={btn}>Add charge</SubmitButton>
        </form>
      </Card>
    </>
  );
}
