import { and, asc, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Allocation, IncomingPayment, MatchSuggestion, Payment } from "../db/schema";
import { round2 } from "./billing";
import { eur } from "./dates";
import { parseBankCsv, type BankFormat } from "./bank-csv";
import { suggestMatches, SUGGEST_AT, type OpenRow } from "./matching";

// Reconciliation: money that arrived (Stripe or bank) -> payment rows.
// Every function takes an optional transaction so the Stripe webhook can do all its work atomically.

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Db = typeof db | Tx;

type Method = NonNullable<Payment["method"]>;

/** Payment rows with money still owed, oldest due first. */
export async function openRows(tx: Db = db, opts: { clientId?: number; ids?: number[] } = {}): Promise<OpenRow[]> {
  const conds = [dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`];
  if (opts.clientId) conds.push(eq(schema.payments.clientId, opts.clientId));
  if (opts.ids?.length) conds.push(inArray(schema.payments.id, opts.ids));
  const rows = await tx
    .select({ p: schema.payments, c: schema.clients })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(and(...conds))
    .orderBy(asc(schema.payments.dueDate), asc(schema.payments.id));
  return rows.map(({ p, c }) => ({
    id: p.id,
    clientId: c.id,
    clientName: c.name,
    contactName: c.contactName,
    email: c.email,
    billingMethod: c.billingMethod,
    label: p.label,
    period: p.period,
    dueDate: p.dueDate,
    amountDue: p.amountDue,
    amountCollected: p.amountCollected,
    stripeInvoiceId: p.stripeInvoiceId,
  }));
}

const joinNote = (old: string | null, add: string) => (old?.includes(add) ? old : [old, add].filter(Boolean).join("\n"));

/** Adds a line to a payment row's notes (skips exact duplicates). */
export async function appendNote(tx: Db, paymentId: number, note: string) {
  const [p] = await tx.select({ notes: schema.payments.notes }).from(schema.payments).where(eq(schema.payments.id, paymentId));
  if (!p) return;
  await tx.update(schema.payments).set({ notes: joinNote(p.notes, note) }).where(eq(schema.payments.id, paymentId));
}

/**
 * Adds money to a payment row, never more than it still owes. Returns the amount applied.
 * The row is locked for the update so concurrent webhooks can't double count.
 */
export async function applyToRow(
  tx: Db,
  paymentId: number,
  amount: number,
  info: { paidDate: string; method: Method; note: string; stripeInvoiceId?: string },
): Promise<number> {
  const [p] = await tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).for("update");
  if (!p) throw new Error(`Payment ${paymentId} not found`);
  const owed = round2(p.amountDue - p.amountCollected);
  const apply = round2(Math.min(amount, owed));
  if (apply <= 0.005) return 0;
  await tx
    .update(schema.payments)
    .set({
      amountCollected: round2(p.amountCollected + apply),
      paidDate: info.paidDate,
      method: info.method,
      notes: joinNote(p.notes, info.note),
      stripeInvoiceId: info.stripeInvoiceId ?? p.stripeInvoiceId,
    })
    .where(eq(schema.payments.id, paymentId));
  return apply;
}

/** Applies what's left of an incoming payment to rows in the given order. Updates the incoming row. */
export async function allocate(
  tx: Db,
  incoming: IncomingPayment,
  rowIds: number[],
  opts: { method: Method; matchedBy: NonNullable<IncomingPayment["matchedBy"]>; note: string },
): Promise<Allocation[]> {
  let left = round2(incoming.amount - incoming.allocated);
  const added: Allocation[] = [];
  for (const id of rowIds) {
    if (left <= 0.005) break;
    const applied = await applyToRow(tx, id, left, {
      paidDate: incoming.receivedDate,
      method: opts.method,
      note: opts.note,
      stripeInvoiceId: incoming.stripeInvoiceId ?? undefined,
    });
    if (applied > 0) {
      added.push({ paymentId: id, amount: applied });
      left = round2(left - applied);
    }
  }
  const allocations = [...incoming.allocations, ...added];
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const [row] = await tx
    .select({ clientId: schema.payments.clientId })
    .from(schema.payments)
    .where(inArray(schema.payments.id, added.length ? added.map((a) => a.paymentId) : [-1]));
  await tx
    .update(schema.incomingPayments)
    .set({
      allocations,
      allocated,
      status: allocated >= incoming.amount - 0.005 ? "matched" : "unmatched",
      matchedBy: added.length ? opts.matchedBy : incoming.matchedBy,
      clientId: incoming.clientId ?? row?.clientId ?? null,
      decidedAt: added.length ? new Date() : incoming.decidedAt,
    })
    .where(eq(schema.incomingPayments.id, incoming.id));
  return added;
}

// ---------- owner actions (Payments page) ----------

/**
 * The owner assigns an unmatched payment (or what's left of it) to a payment row.
 * For Stripe payments, linkStripeCustomer also saves the Stripe customer ID on the client so the next one matches itself.
 */
export async function assignIncoming(incomingId: number, paymentId: number, opts: { linkStripeCustomer?: boolean } = {}) {
  return db.transaction(async (tx) => {
    const [inc] = await tx.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.id, incomingId)).for("update");
    if (!inc) throw new Error(`Incoming payment ${incomingId} not found`);
    if (inc.status === "ignored") throw new Error("This payment was ignored. Restore it first.");
    if (inc.amount - inc.allocated <= 0.005) throw new Error("This payment is already fully assigned.");
    const [row] = await tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    if (!row) throw new Error(`Payment row ${paymentId} not found`);
    const method: Method = inc.source === "stripe" ? "stripe" : ((inc.bankFormat as Method | null) ?? "invoice");
    const what = inc.source === "stripe" ? `Stripe invoice ${inc.stripeInvoiceId ?? inc.externalId}` : `${inc.bankFormat ?? "bank"} credit`;
    const added = await allocate(tx, inc, [paymentId], {
      method,
      matchedBy: "owner",
      note: `${what} of ${eur(inc.amount)} on ${inc.receivedDate} (${[inc.payer, inc.reference].filter(Boolean).join(" / ") || "no reference"}) assigned by owner`,
    });
    if (!added.length) throw new Error("That row has nothing left to pay.");
    if (opts.linkStripeCustomer && inc.stripeCustomerId) {
      await tx
        .update(schema.clients)
        .set({ stripeCustomerId: inc.stripeCustomerId })
        .where(and(eq(schema.clients.id, row.clientId), dsql`${schema.clients.stripeCustomerId} is null`));
    }
    return added[0];
  });
}

export async function ignoreIncoming(incomingId: number, note?: string) {
  await db
    .update(schema.incomingPayments)
    .set({ status: "ignored", decidedAt: new Date(), notes: note ?? "Ignored by owner (not a client payment)." })
    .where(and(eq(schema.incomingPayments.id, incomingId), eq(schema.incomingPayments.allocated, 0)));
}

export async function restoreIncoming(incomingId: number) {
  await db
    .update(schema.incomingPayments)
    .set({ status: "unmatched", decidedAt: null })
    .where(and(eq(schema.incomingPayments.id, incomingId), eq(schema.incomingPayments.status, "ignored")));
}

export interface UnmatchedItem extends IncomingPayment {
  remaining: number;
  /** Fresh suggestions against today's open rows. */
  live: (MatchSuggestion & { row: OpenRow })[];
}

/** Unmatched incoming payments with live suggestions, newest first. */
export async function listUnmatched(tx: Db = db): Promise<UnmatchedItem[]> {
  const [items, rows] = await Promise.all([
    tx.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.status, "unmatched")).orderBy(desc(schema.incomingPayments.receivedDate), desc(schema.incomingPayments.id)),
    openRows(tx),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return items.map((i) => {
    const remaining = round2(i.amount - i.allocated);
    const pool = i.clientId && i.source === "stripe" ? rows.filter((r) => r.clientId === i.clientId) : rows;
    const live = suggestMatches(
      { date: i.receivedDate, amount: remaining, payer: i.payer, reference: i.reference, description: i.description, channel: i.source === "stripe" ? "stripe" : i.bankFormat },
      pool.length ? pool : rows,
    ).map((s) => ({ ...s, row: byId.get(s.paymentId)! }));
    return { ...i, remaining, live };
  });
}

// ---------- bank CSV ----------

export interface BankImportResult {
  format: string;
  credits: number;
  inserted: number;
  duplicates: number;
  suggested: number;
  skipped: number;
  errors: string[];
}

/**
 * Imports the credits from a Revolut Business or AIB CSV export as unmatched incoming payments,
 * each with suggested matches. Nothing is applied to payment rows: the owner confirms each match.
 * Re-uploading the same (or an overlapping) export is safe: rows already imported are skipped.
 */
export async function importBankCsv(text: string, opts: { format?: BankFormat["id"]; fileName?: string } = {}): Promise<BankImportResult> {
  const parsed = parseBankCsv(text, opts.format);
  const rows = await openRows();
  let inserted = 0;
  let suggested = 0;
  for (const c of parsed.credits) {
    const suggestions = suggestMatches({ ...c, channel: parsed.format.id }, rows);
    const [row] = await db
      .insert(schema.incomingPayments)
      .values({
        source: "bank",
        externalId: c.externalId,
        receivedDate: c.date,
        amount: c.amount,
        currency: c.currency,
        payer: c.payer,
        reference: c.reference,
        description: c.description,
        bankFormat: parsed.format.id,
        sourceFile: opts.fileName ?? null,
        suggestions,
        notes: c.currency !== "EUR" ? `Paid in ${c.currency}, not EUR: check the amount before confirming.` : null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.incomingPayments.id });
    if (row) {
      inserted++;
      if (suggestions[0]?.score >= SUGGEST_AT) suggested++;
    }
  }
  return {
    format: parsed.format.label,
    credits: parsed.credits.length,
    inserted,
    duplicates: parsed.credits.length - inserted,
    suggested,
    skipped: parsed.skipped,
    errors: parsed.errors,
  };
}
