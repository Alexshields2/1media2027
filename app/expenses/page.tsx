import Link from "next/link";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/roles";
import { addMonths, eur, monthLabel, monthStart, today } from "@/lib/dates";
import { listExpenses, monthlyTrend, monthSummary, type ExpenseRow } from "@/lib/expenses";
import { categoryLabel, EXCLUDED_FROM_TOTALS, EXPENSE_CATEGORIES, euroValue, type ExpenseCategory } from "@/lib/expense-rules";
import { aiCategoriserReady } from "@/lib/expense-ai";
import { currentStatus } from "@/lib/revolut/connection";
import { BANK_FORMATS } from "@/lib/bank-csv";
import { Badge, Card, Empty, NoAccess, Notice, PageHeader, Table, btn, btnGhost, btnLink, btnSm, field, input, td, tdNum } from "../_components/ui";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { CategorySelect } from "./expense-bits";
import { addExpenseAction, categoriseAiAction, importExpensesAction, setCategoryAction, syncRevolutFromExpensesAction, updateExpenseAction } from "./actions";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { revolut: "Revolut", csv: "CSV", manual: "Manual" };
const shortMonth = (m: string) => monthLabel(`${m}-01`).replace(/^(\w{3})\w*\s(\d{2})(\d{2})$/, "$1 ’$3");

type SP = { month?: string; q?: string; category?: string; client?: string; imported?: string; error?: string };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  if (!can(user.role, "payments")) return <NoAccess what="Expenses" />;
  const sp = await searchParams;
  const period = monthStart(/^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : today());
  const month = period.slice(0, 7);
  const clientId = Number(sp.client) || undefined;
  const filtered = !!(sp.q || sp.category || clientId);

  const [summary, trend, rows, clients, revolut] = await Promise.all([
    monthSummary(month),
    monthlyTrend(month, 12),
    listExpenses({ month, q: sp.q, category: sp.category, clientId, limit: 500 }),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(schema.clients.name),
    currentStatus().catch(() => null),
  ]);
  const prevTotal = trend.at(-2)?.total ?? 0;
  const counted = summary.byCategory.filter((c) => !EXCLUDED_FROM_TOTALS.includes(c.category as ExpenseCategory));
  const transfers = summary.byCategory.find((c) => c.category === "transfers");
  const catMax = Math.max(...counted.map((c) => c.total), 0.01);
  const trendMax = Math.max(...trend.map((t) => t.total), 0.01);
  const keep = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ month, q: sp.q, category: sp.category, client: sp.client, ...extra })) if (v) q.set(k, v);
    return `/expenses?${q}`;
  };
  const revolutStatus = revolut?.status;

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Everything that left the business: Revolut card payments, transfers and fees, imports and manual entries."
        actions={
          <>
            <a href={`/api/expenses/export?month=${month}`} className={btnGhost}>
              <Icon name="download" /> Export {monthLabel(period).split(" ")[0]}
            </a>
            <a href="#add" className={btn}>
              <Icon name="plus" /> Add expense
            </a>
          </>
        }
      />

      {sp.imported && <Notice tone="success">{sp.imported}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {revolutStatus === "needs_reauth" && (
        <Notice tone="error" title="Revolut needs re-authorising">
          New Revolut expenses aren&rsquo;t coming in. <Link href="/integrations#revolut" className="underline">Open Integrations</Link> and click Authorise.
        </Notice>
      )}

      {/* Month header */}
      <section className="surface relative mb-6 overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_0%_0%,rgb(4_153_242/0.16),transparent_60%)]" />
        <div className="relative p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Link className="grid size-9 place-items-center rounded-full border border-line bg-canvas/60 text-soft hover:border-brand/50 hover:text-white" href={keep({ month: addMonths(period, -1).slice(0, 7) })} aria-label="Previous month">
                <Icon name="chevronLeft" />
              </Link>
              <h2 className="min-w-40 text-center text-lg font-semibold text-white">{monthLabel(period)}</h2>
              <Link className="grid size-9 place-items-center rounded-full border border-line bg-canvas/60 text-soft hover:border-brand/50 hover:text-white" href={keep({ month: addMonths(period, 1).slice(0, 7) })} aria-label="Next month">
                <Icon name="chevronRight" />
              </Link>
              {period !== monthStart() && (
                <Link href="/expenses" className={`${btnLink} ml-1`}>
                  This month
                </Link>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {revolutStatus === "connected" ? (
                <form action={syncRevolutFromExpensesAction} className="flex items-center gap-2">
                  <input type="hidden" name="month" value={month} />
                  <Badge tone="green" dot>
                    Revolut synced {revolut?.conn?.lastSyncAt ? revolut.conn.lastSyncAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–"}
                  </Badge>
                  <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Syncing…">
                    Sync now
                  </SubmitButton>
                </form>
              ) : revolutStatus !== "needs_reauth" ? (
                <Link href="/integrations#revolut" className={`${btnGhost} ${btnSm}`}>
                  <Icon name="plug" className="size-3.5" /> Connect Revolut Business
                </Link>
              ) : null}
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Spent</div>
              <div className="num mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{eur(summary.total)}</div>
              <div className="mt-0.5 text-xs text-muted">{prevTotal ? `${eur(prevTotal)} last month` : "excl. own transfers"}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Expenses</div>
              <div className="num mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{summary.count - (transfers?.count ?? 0)}</div>
              <div className="mt-0.5 text-xs text-muted">{transfers ? `${transfers.count} own transfer${transfers.count === 1 ? "" : "s"} excluded` : "in the month"}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Uncategorised</div>
              <div className={`num mt-1 text-2xl font-semibold tracking-tight sm:text-3xl ${summary.uncategorised ? "text-amber-300" : "text-emerald-300"}`}>{summary.uncategorised}</div>
              <div className="mt-0.5 text-xs text-muted">{summary.uncategorised ? <Link href={keep({ category: "none" })} className="underline-offset-2 hover:underline">Show them</Link> : "all sorted"}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Rechargeable</div>
              <div className="num mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{eur(summary.rechargeable)}</div>
              <div className="mt-0.5 text-xs text-muted">attached to clients</div>
            </div>
          </div>
          {summary.unconverted > 0 && <p className="mt-4 text-xs text-amber-300/90">{summary.unconverted} expense(s) in another currency have no euro amount yet and aren&rsquo;t in the total.</p>}
        </div>
      </section>

      <div className="mb-6 grid gap-6 lg:grid-cols-5">
        <Card title="By category" description={`${monthLabel(period)}, in euro`} className="lg:col-span-2">
          {counted.length ? (
            <ul className="space-y-3" aria-label="Spend by category">
              {counted.map((c) => (
                <li key={c.category ?? "none"}>
                  <Link href={keep({ category: c.category ?? "none" })} className="group block" title={`${categoryLabel(c.category)}: ${eur(c.total)} (${c.count})`}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className={`truncate group-hover:text-white ${c.category ? "text-soft" : "text-amber-300"}`}>{categoryLabel(c.category)}</span>
                      <span className="num shrink-0 text-white">{eur(c.total)}</span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-full bg-ink/[0.06]">
                      <div className={`h-2 rounded-full ${c.category ? "bg-brand-light" : "bg-amber-400"}`} style={{ width: `${Math.max((c.total / catMax) * 100, 1.5)}%` }} />
                    </div>
                  </Link>
                </li>
              ))}
              {transfers && (
                <li className="border-t border-line pt-3 text-xs text-muted">
                  Transfers between own accounts: {eur(transfers.total)} ({transfers.count}), not counted.
                </li>
              )}
            </ul>
          ) : (
            <Empty icon="euro" title="Nothing spent this month" compact>
              Connect Revolut or import a statement below.
            </Empty>
          )}
        </Card>

        <Card title="Last 12 months" description="Spend per month, own transfers excluded" className="lg:col-span-3">
          <div className="flex h-44 items-end gap-1.5 sm:gap-2" role="img" aria-label={trend.map((t) => `${shortMonth(t.month)}: ${eur(t.total)}`).join(", ")}>
            {trend.map((t) => {
              const on = t.month === month;
              return (
                <Link key={t.month} href={keep({ month: t.month })} title={`${monthLabel(`${t.month}-01`)}: ${eur(t.total)}`} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                  <span className={`num hidden text-[10px] sm:block ${on ? "text-white" : "text-transparent group-hover:text-soft"}`}>{t.total >= 1000 ? `${Math.round(t.total / 100) / 10}k` : Math.round(t.total)}</span>
                  <span className={`w-full max-w-9 rounded-t-[4px] transition-colors ${on ? "bg-brand-light" : "bg-brand-light/35 group-hover:bg-brand-light/60"}`} style={{ height: `${Math.max((t.total / trendMax) * 100, t.total ? 2 : 0.5)}%` }} />
                  <span className={`text-[10px] whitespace-nowrap ${on ? "font-semibold text-white" : "text-muted"}`}>{shortMonth(t.month).split(" ")[0]}</span>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <Card
        flush
        title={`${monthLabel(period)} expenses${filtered ? ` (${rows.length} shown)` : ""}`}
        description="Change a category once and that merchant is remembered."
        actions={
          summary.uncategorised > 0 && aiCategoriserReady() ? (
            <form action={categoriseAiAction}>
              <input type="hidden" name="month" value={month} />
              <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Asking Claude…">
                <Icon name="spark" className="size-3.5" /> Categorise {summary.uncategorised} with Claude
              </SubmitButton>
            </form>
          ) : undefined
        }
      >
        <form className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5" action="/expenses">
          <input type="hidden" name="month" value={month} />
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search merchant, description, notes" aria-label="Search expenses" className={`${field} w-64 max-w-full`} />
          <select name="category" defaultValue={sp.category ?? ""} aria-label="Filter by category" className={`${field} w-56 max-w-full`}>
            <option value="">All categories</option>
            <option value="none">Uncategorised</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select name="client" defaultValue={sp.client ?? ""} aria-label="Filter by client" className={`${field} w-48 max-w-full`}>
            <option value="">Any client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className={`${btnGhost} ${btnSm}`}>
            <Icon name="search" className="size-3.5" /> Filter
          </button>
          {filtered && (
            <Link href={keep({ q: "", category: "", client: "" })} className={btnLink}>
              Clear
            </Link>
          )}
        </form>
        {rows.length ? (
          <>
          {/* Phone: one stacked card per expense */}
          <ul className="divide-y divide-line/70 md:hidden">
            {rows.map((e) => (
              <li key={e.id} className={`px-4 py-3 ${EXCLUDED_FROM_TOTALS.includes(e.category as ExpenseCategory) ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium break-words text-white">{e.merchant}</div>
                    <div className="text-xs text-muted">
                      {e.date.slice(8)}/{e.date.slice(5, 7)} · {SOURCE_LABEL[e.source]}
                      {e.cardLast4 ? ` · •${e.cardLast4}` : ""}
                      {e.client ? ` · ${e.client}` : ""}
                    </div>
                  </div>
                  <div className="num shrink-0 text-right text-white">
                    {eur(e.amount, e.currency)}
                    {e.currency !== "EUR" && <div className="text-xs text-muted">{e.amountEur !== null ? eur(euroValue(e)) : "no € amount"}</div>}
                  </div>
                </div>
                <form action={setCategoryAction} className="mt-2 flex flex-wrap items-center">
                  <input type="hidden" name="id" value={e.id} />
                  <CategorySelect
                    name="category"
                    defaultValue={e.category ?? ""}
                    options={EXPENSE_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
                    label={`Category of ${e.merchant}`}
                    className={`${field} w-full py-1.5 text-xs ${e.category ? "" : "border-amber-400/50"}`}
                  />
                </form>
                <EditDetails e={e} month={month} clients={clients} />
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
          <Table head={["Date", "Merchant", { label: "Amount", align: "right" }, "Category", "Client · VAT · notes"]} minWidth={920}>
            {rows.map((e) => {
              const excluded = EXCLUDED_FROM_TOTALS.includes(e.category as ExpenseCategory);
              return (
                <tr key={e.id} className={`align-top ${excluded ? "opacity-60" : ""}`}>
                  <td className={`${td} whitespace-nowrap text-soft`}>
                    {e.date.slice(8)}/{e.date.slice(5, 7)}
                    <div className="mt-1">
                      <Badge tone={e.source === "revolut" ? "brand" : "gray"}>{SOURCE_LABEL[e.source]}</Badge>
                    </div>
                  </td>
                  <td className={`${td} max-w-72`}>
                    <div className="font-medium break-words text-white">{e.merchant}</div>
                    {e.description && <div className="text-xs break-words text-muted">{e.description}</div>}
                    {e.cardLast4 && <div className="text-[11px] text-muted">Card •{e.cardLast4}</div>}
                  </td>
                  <td className={tdNum}>
                    <span className="text-white">{eur(e.amount, e.currency)}</span>
                    {e.currency !== "EUR" && <div className="text-xs text-muted">{e.amountEur !== null ? eur(euroValue(e)) : "no € amount"}</div>}
                    {e.vatAmount !== null && <div className="text-xs text-muted">VAT {eur(e.vatAmount, e.currency)}</div>}
                  </td>
                  <td className={td}>
                    <form action={setCategoryAction} className="flex flex-wrap items-center">
                      <input type="hidden" name="id" value={e.id} />
                      <CategorySelect
                        name="category"
                        defaultValue={e.category ?? ""}
                        options={EXPENSE_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
                        label={`Category for ${e.merchant}`}
                        className={`${field} w-52 py-1.5 text-xs ${e.category ? "" : "border-amber-400/50"}`}
                      />
                    </form>
                    <div className="mt-1 text-[11px] text-muted">
                      {e.categorySource === "ai" ? "by Claude" : e.categorySource === "memory" ? "remembered" : e.categorySource === "rule" ? "auto" : e.categorySource === "owner" ? "set by you" : ""}
                    </div>
                  </td>
                  <td className={td}>
                    <div className="text-xs text-soft">
                      {[e.client && `Recharge: ${e.client}`, e.notes].filter(Boolean).join(" · ") || <span className="text-muted">–</span>}
                      {e.receiptUrl && (
                        <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="ml-1 underline">
                          receipt
                        </a>
                      )}
                    </div>
                    <EditDetails e={e} month={month} clients={clients} />
                  </td>
                </tr>
              );
            })}
          </Table>
          </div>
          </>
        ) : (
          <Empty icon="euro" title={filtered ? "No expenses match" : `No expenses in ${monthLabel(period)}`} compact>
            {filtered ? "Try another search or clear the filters." : "Revolut syncs daily once connected; older months come in from a statement CSV."}
          </Empty>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card id="add" title="Add an expense" description="Cash, a personal card, anything not in Revolut" className="scroll-mt-24">
          <form action={addExpenseAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="month" value={month} />
            <input type="date" name="date" required defaultValue={period === monthStart() ? today() : period} aria-label="Date" className={input} />
            <input name="merchant" required placeholder="Paid to, e.g. Canva" aria-label="Paid to" className={input} />
            <div className="flex gap-2">
              <input name="amount" required placeholder="Amount" inputMode="decimal" aria-label="Amount" className={`${input} num`} />
              <input name="currency" defaultValue="EUR" maxLength={3} aria-label="Currency" className={`${field} w-20 uppercase`} />
            </div>
            <select name="category" defaultValue="" aria-label="Category" className={input}>
              <option value="">Category (auto)</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <input name="vat" placeholder="VAT (optional)" inputMode="decimal" aria-label="VAT" className={`${input} num`} />
            <select name="clientId" defaultValue="" aria-label="Rechargeable to client" className={input}>
              <option value="">Not rechargeable</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input name="notes" placeholder="Note (optional)" aria-label="Note" className={`${input} sm:col-span-2`} />
            <div className="sm:col-span-2">
              <SubmitButton className={btn}>Add expense</SubmitButton>
            </div>
          </form>
        </Card>

        <Card title="Import a statement" description="For history before Revolut was connected">
          <form action={importExpensesAction} className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-canvas/40 p-4">
            <input type="hidden" name="month" value={month} />
            <input type="file" name="file" accept=".csv,text/csv" required aria-label="Statement CSV file" className="max-w-full text-sm text-soft file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm file:text-ink" />
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
          </form>
          <p className="mt-3 text-xs text-muted">
            Revolut Business → Statements → choose the account and dates → Excel/CSV. Only money out is read here (money in is matched on Payments). Uploading the same or an
            overlapping file twice is safe, and rows Revolut already synced are skipped.
          </p>
        </Card>
      </div>
    </>
  );
}

function EditDetails({ e, month, clients }: { e: ExpenseRow; month: string; clients: { id: number; name: string }[] }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">Client, VAT, receipt, note</summary>
      <form action={updateExpenseAction} className="mt-2 grid w-full max-w-64 gap-1.5">
        <input type="hidden" name="id" value={e.id} />
        <input type="hidden" name="month" value={month} />
        <select name="clientId" defaultValue={e.clientId ?? ""} aria-label="Rechargeable to client" className={`${field} py-1.5 text-xs`}>
          <option value="">Not rechargeable</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input name="vat" defaultValue={e.vatAmount ?? ""} placeholder="VAT amount" inputMode="decimal" aria-label="VAT amount" className={`${field} num py-1.5 text-xs`} />
        <input name="receiptUrl" defaultValue={e.receiptUrl ?? ""} placeholder="Receipt link (https://…)" aria-label="Receipt link" className={`${field} py-1.5 text-xs`} />
        <textarea name="notes" defaultValue={e.notes ?? ""} rows={2} placeholder="Note" aria-label="Note" className={`${field} py-1.5 text-xs`} />
        <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Saving…">
          Save
        </SubmitButton>
      </form>
    </details>
  );
}
