import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Expense } from "../db/schema";
import { addMonths, monthStart } from "./dates";
import { parseBankCsv, type BankDebit, type BankFormat } from "./bank-csv";
import { builtInCategory, CATEGORY_KEYS, euroValue, EXCLUDED_FROM_TOTALS, expensesCsv, isCategory, merchantKey, type CategoryHint, type ExpenseCategory } from "./expense-rules";

// Expenses: money out of the business. Revolut sync (src/lib/revolut/sync.ts), statement CSV upload
// and manual entry all end in insertExpenses(), which dedupes and categorises.
//
// Category order: 1. the owner's merchant memory, 2. built-in rules, 3. left empty for the owner
// (or Claude, src/lib/expense-ai.ts, when ANTHROPIC_API_KEY is set).

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ExpenseInput {
  externalId: string;
  date: string;
  merchant: string;
  description?: string | null;
  amount: number;
  currency: string;
  amountEur?: number | null;
  revolutAccountId?: string | null;
  cardLast4?: string | null;
  notes?: string | null;
  vatAmount?: number | null;
  clientId?: number | null;
  receiptUrl?: string | null;
  category?: ExpenseCategory | null;
  hint?: Omit<CategoryHint, "merchant" | "description">;
}

/** The owner's merchant rules for these keys. */
export async function merchantRules(keys: string[]): Promise<Map<string, ExpenseCategory>> {
  if (!keys.length) return new Map();
  const rows = await db.select().from(schema.expenseMerchantRules).where(inArray(schema.expenseMerchantRules.merchantKey, [...new Set(keys)]));
  return new Map(rows.filter((r) => isCategory(r.category)).map((r) => [r.merchantKey, r.category as ExpenseCategory]));
}

/**
 * Inserts expenses that aren't already recorded (by external ID, across every source, so a Revolut
 * CSV and the Revolut API never double count). Existing rows are never touched: the owner's edits stay.
 */
export async function insertExpenses(items: ExpenseInput[], source: Expense["source"]): Promise<{ inserted: number; duplicates: number; uncategorised: number }> {
  const unique = [...new Map(items.map((i) => [i.externalId, i])).values()];
  if (!unique.length) return { inserted: 0, duplicates: items.length, uncategorised: 0 };
  const existing = new Set<string>();
  for (let i = 0; i < unique.length; i += 500) {
    const ids = unique.slice(i, i + 500).map((x) => x.externalId);
    for (const r of await db.select({ id: schema.expenses.externalId }).from(schema.expenses).where(inArray(schema.expenses.externalId, ids))) existing.add(r.id);
  }
  const fresh = unique.filter((i) => !existing.has(i.externalId));
  const rules = await merchantRules(fresh.map((i) => merchantKey(i.merchant)));
  let inserted = 0;
  let uncategorised = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const values = fresh.slice(i, i + 200).map((x) => {
      const key = merchantKey(x.merchant);
      const hint = { merchant: x.merchant, description: x.description, ...x.hint };
      // Own-account transfers are always transfers, whatever the merchant memory says.
      const remembered = hint.ownTransfer ? undefined : rules.get(key);
      const rule = builtInCategory(hint);
      const category = x.category ?? remembered ?? rule;
      const categorySource = x.category ? ("owner" as const) : remembered ? ("memory" as const) : rule ? ("rule" as const) : null;
      if (!category) uncategorised++;
      return {
        date: x.date,
        merchant: x.merchant.slice(0, 200),
        merchantKey: key,
        description: x.description ?? null,
        amount: round2(Math.abs(x.amount)),
        currency: x.currency.toUpperCase(),
        amountEur: x.amountEur ?? (x.currency.toUpperCase() === "EUR" ? round2(Math.abs(x.amount)) : null),
        category,
        categorySource,
        vatAmount: x.vatAmount ?? null,
        clientId: x.clientId ?? null,
        source,
        externalId: x.externalId,
        revolutAccountId: x.revolutAccountId ?? null,
        cardLast4: x.cardLast4 ?? null,
        receiptUrl: x.receiptUrl ?? null,
        notes: x.notes ?? null,
      };
    });
    const rows = await db.insert(schema.expenses).values(values).onConflictDoNothing().returning({ id: schema.expenses.id });
    inserted += rows.length;
  }
  return { inserted, duplicates: items.length - inserted, uncategorised };
}

export function debitToExpense(d: BankDebit): ExpenseInput {
  return {
    externalId: d.externalId,
    date: d.date,
    merchant: d.counterparty,
    description: [d.description, d.reference].filter(Boolean).join(" · ") || null,
    amount: d.amount,
    currency: d.currency,
    cardLast4: d.cardLast4,
    notes: d.currency !== "EUR" ? `Paid in ${d.currency}: check the euro amount.` : null,
    hint: { type: d.type, mcc: d.mcc, ownTransfer: d.ownTransfer },
  };
}

export interface ExpenseImportResult {
  format: string;
  debits: number;
  inserted: number;
  duplicates: number;
  uncategorised: number;
  credits: number;
  errors: string[];
}

/** Imports the money-out rows of a Revolut Business (or AIB) statement CSV. Re-uploading is safe. */
export async function importExpenseCsv(text: string, opts: { format?: BankFormat["id"] } = {}): Promise<ExpenseImportResult> {
  const parsed = parseBankCsv(text, opts.format);
  const r = await insertExpenses(parsed.debits.map(debitToExpense), "csv");
  return { format: parsed.format.label, debits: parsed.debits.length, ...r, credits: parsed.credits.length, errors: parsed.errors };
}

/**
 * The owner sets an expense's category. With remember (the default) the merchant is remembered:
 * its other expenses that weren't set by hand follow now, and future ones follow on import.
 */
export async function setExpenseCategory(id: number, category: ExpenseCategory, opts: { userId?: number; remember?: boolean } = {}): Promise<{ alsoUpdated: number }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.update(schema.expenses).set({ category, categorySource: "owner", updatedAt: new Date() }).where(eq(schema.expenses.id, id)).returning();
    if (!e) throw new Error(`Expense ${id} not found`);
    if (opts.remember === false || category === "transfers") return { alsoUpdated: 0 };
    await tx
      .insert(schema.expenseMerchantRules)
      .values({ merchantKey: e.merchantKey, category, updatedBy: opts.userId ?? null })
      .onConflictDoUpdate({ target: schema.expenseMerchantRules.merchantKey, set: { category, updatedBy: opts.userId ?? null, updatedAt: new Date() } });
    const others = await tx
      .update(schema.expenses)
      .set({ category, categorySource: "memory", updatedAt: new Date() })
      .where(
        and(
          eq(schema.expenses.merchantKey, e.merchantKey),
          ne(schema.expenses.id, id),
          or(isNull(schema.expenses.categorySource), ne(schema.expenses.categorySource, "owner")),
          or(isNull(schema.expenses.category), ne(schema.expenses.category, "transfers")),
        ),
      )
      .returning({ id: schema.expenses.id });
    return { alsoUpdated: others.length };
  });
}

/** Notes, client recharge, VAT and receipt link on one expense. Undefined fields are left as they are. */
export async function updateExpenseDetails(id: number, d: { notes?: string | null; clientId?: number | null; vatAmount?: number | null; receiptUrl?: string | null }) {
  const set: Partial<typeof schema.expenses.$inferInsert> = { updatedAt: new Date() };
  if (d.notes !== undefined) set.notes = d.notes;
  if (d.clientId !== undefined) set.clientId = d.clientId;
  if (d.vatAmount !== undefined) set.vatAmount = d.vatAmount === null ? null : round2(d.vatAmount);
  if (d.receiptUrl !== undefined) set.receiptUrl = d.receiptUrl;
  await db.update(schema.expenses).set(set).where(eq(schema.expenses.id, id));
}

/** A manual expense (cash, a personal card, anything not in Revolut). */
export async function addManualExpense(i: Omit<ExpenseInput, "externalId">): Promise<number> {
  const externalId = `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  await insertExpenses([{ ...i, externalId }], "manual");
  const [row] = await db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.externalId, externalId));
  return row.id;
}

// ---------- reading ----------

export interface ExpenseFilter {
  /** YYYY-MM. */
  month?: string;
  from?: string;
  to?: string;
  q?: string;
  /** A category key, or "none" for uncategorised. */
  category?: string;
  clientId?: number;
  limit?: number;
}

function monthRange(month: string) {
  const start = monthStart(`${month}-01`);
  return { from: start, to: addMonths(start, 1) };
}

function filterConds(f: ExpenseFilter) {
  const conds = [];
  const range = f.month ? monthRange(f.month) : { from: f.from, to: f.to };
  if (range.from) conds.push(gte(schema.expenses.date, range.from));
  if (range.to) conds.push(lt(schema.expenses.date, range.to));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(schema.expenses.merchant, like), ilike(schema.expenses.description, like), ilike(schema.expenses.notes, like)));
  }
  if (f.category === "none") conds.push(isNull(schema.expenses.category));
  else if (f.category && isCategory(f.category)) conds.push(eq(schema.expenses.category, f.category));
  if (f.clientId) conds.push(eq(schema.expenses.clientId, f.clientId));
  return conds;
}

export type ExpenseRow = Expense & { client: string | null };

export async function listExpenses(f: ExpenseFilter = {}): Promise<ExpenseRow[]> {
  const conds = filterConds(f);
  const rows = await db
    .select({ e: schema.expenses, client: schema.clients.name })
    .from(schema.expenses)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.expenses.clientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.expenses.date), desc(schema.expenses.id))
    .limit(f.limit ?? 1000);
  return rows.map((r) => ({ ...r.e, client: r.client }));
}

export interface MonthSummary {
  month: string;
  total: number;
  count: number;
  uncategorised: number;
  /** Euro totals per category, largest first; transfers listed but never counted in total. */
  byCategory: { category: string | null; total: number; count: number }[];
  /** Amounts paid in another currency with no euro value (left out of the total). */
  unconverted: number;
  rechargeable: number;
}

export async function monthSummary(month: string): Promise<MonthSummary> {
  const rows = await listExpenses({ month, limit: 100_000 });
  const by = new Map<string | null, { total: number; count: number }>();
  let total = 0;
  let unconverted = 0;
  let rechargeable = 0;
  for (const r of rows) {
    const v = euroValue(r);
    if (r.amountEur === null && r.currency !== "EUR") unconverted++;
    const b = by.get(r.category) ?? { total: 0, count: 0 };
    b.total += v;
    b.count++;
    by.set(r.category, b);
    if (!EXCLUDED_FROM_TOTALS.includes(r.category as ExpenseCategory)) {
      total += v;
      if (r.clientId) rechargeable += v;
    }
  }
  const byCategory = [...by.entries()].map(([category, b]) => ({ category, total: round2(b.total), count: b.count })).sort((a, b) => b.total - a.total);
  return {
    month,
    total: round2(total),
    count: rows.length,
    uncategorised: by.get(null)?.count ?? 0,
    byCategory,
    unconverted,
    rechargeable: round2(rechargeable),
  };
}

/** Euro spend per month (transfers left out) for the months ending with `month`, oldest first. */
export async function monthlyTrend(month: string, months = 12): Promise<{ month: string; total: number }[]> {
  const end = addMonths(monthStart(`${month}-01`), 1);
  const start = addMonths(end, -months);
  const rows = await db
    .select({
      m: dsql<string>`to_char(${schema.expenses.date}, 'YYYY-MM')`,
      total: dsql<string>`coalesce(sum(coalesce(${schema.expenses.amountEur}, case when ${schema.expenses.currency} = 'EUR' then ${schema.expenses.amount} else 0 end)), 0)`,
    })
    .from(schema.expenses)
    .where(
      and(
        gte(schema.expenses.date, start),
        lt(schema.expenses.date, end),
        or(isNull(schema.expenses.category), dsql`${schema.expenses.category} not in (${dsql.join(EXCLUDED_FROM_TOTALS.map((c) => dsql`${c}`), dsql`, `)})`),
      ),
    )
    .groupBy(dsql`1`)
    .orderBy(asc(dsql`1`));
  const by = new Map(rows.map((r) => [r.m, Number(r.total)]));
  const out = [];
  for (let m = start; m < end; m = addMonths(m, 1)) out.push({ month: m.slice(0, 7), total: round2(by.get(m.slice(0, 7)) ?? 0) });
  return out;
}

export async function exportExpensesCsv(f: ExpenseFilter): Promise<string> {
  const rows = await listExpenses({ ...f, limit: 100_000 });
  return expensesCsv([...rows].reverse());
}

export { CATEGORY_KEYS };
