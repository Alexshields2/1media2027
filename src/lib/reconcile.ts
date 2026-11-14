import { and, asc, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Allocation, IncomingPayment, MatchSuggestion, Payment } from "../db/schema";
import { amountDue, round2 } from "./billing";
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

// ---------- owner actions (Payments page) ----------

/** One slice of an incoming payment: an existing payment row, or a client + month (the row is created from the retainer). */
export type AssignPart = { paymentId?: number; clientId?: number; period?: string; amount?: number };

/**
 * The owner assigns an unmatched payment (or what's left of it) to a payment row.
 * For Stripe payments, linkStripeCustomer also saves the Stripe customer ID on the client so the next one matches itself.
 */
export async function assignIncoming(incomingId: number, paymentId: number, opts: { linkStripeCustomer?: boolean } = {}) {
  const added = await assignIncomingParts(incomingId, [{ paymentId }], opts);
  return added[0];
}

/**
 * The owner decides which month(s) a payment covers. Each part names a payment row (or a client and month, whose
 * row is created from the retainer if it doesn't exist yet: clients sometimes pay ahead) and how much of the
 * payment goes there. A part without an amount takes what that row still owes (capped at what's left).
 * Nothing is applied unless every part fits; the whole thing is one transaction.
 */
export async function assignIncomingParts(incomingId: number, parts: AssignPart[], opts: { linkStripeCustomer?: boolean } = {}): Promise<Allocation[]> {
  if (!parts.length) throw new Error("Choose at least one month.");
  return db.transaction(async (tx) => {
    const [inc] = await tx.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.id, incomingId)).for("update");
    if (!inc) throw new Error(`Incoming payment ${incomingId} not found`);
    if (inc.status === "ignored") throw new Error("This payment was ignored. Restore it first.");
    let left = round2(inc.amount - inc.allocated);
    if (left <= 0.005) throw new Error("This payment is already fully assigned.");
    const asked = round2(parts.reduce((s, p) => s + (p.amount ?? 0), 0));
    if (asked > left + 0.005) throw new Error(`That's ${eur(asked)} but only ${eur(left)} of this payment is left to assign.`);

    const method: Method = inc.source === "stripe" ? "stripe" : ((inc.bankFormat as Method | null) ?? "invoice");
    const note =
      inc.source === "stripe"
        ? `Stripe invoice ${inc.reference ?? inc.stripeInvoiceId ?? inc.externalId} of ${eur(inc.amount)} paid ${inc.receivedDate}${inc.payer ? ` (${inc.payer})` : ""}, assigned by owner`
        : `${inc.bankFormat ?? "bank"} credit of ${eur(inc.amount)} on ${inc.receivedDate} (${[inc.payer, inc.reference].filter(Boolean).join(" / ") || "no reference"}) assigned by owner`;

    const added: Allocation[] = [];
    const clientIds = new Set<number>();
    for (const part of parts) {
      if (part.amount !== undefined && !(part.amount > 0)) throw new Error("Each amount must be more than zero.");
      const row = await resolveRow(tx, part, part.amount ?? left);
      clientIds.add(row.clientId);
      const want = round2(Math.min(part.amount ?? left, left));
      if (want <= 0.005) break;
      const applied = await applyToRow(tx, row.id, want, { paidDate: inc.receivedDate, method, note, stripeInvoiceId: inc.stripeInvoiceId ?? undefined });
      if (part.amount !== undefined && applied < want - 0.005) {
        throw new Error(`${monthLabelShort(row.period)} only owes ${eur(applied)}; lower that amount or pick another month.`);
      }
      if (applied <= 0.005) throw new Error(`${monthLabelShort(row.period)} is already paid in full.`);
      added.push({ paymentId: row.id, amount: applied });
      left = round2(left - applied);
    }
    if (!added.length) throw new Error("Nothing was assigned.");

    const allocations = [...inc.allocations, ...added];
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
    const clientId = inc.clientId ?? (clientIds.size === 1 ? [...clientIds][0] : null);
    await tx
      .update(schema.incomingPayments)
      .set({
        allocations,
        allocated,
        status: allocated >= inc.amount - 0.005 ? "matched" : "unmatched",
        matchedBy: "owner",
        clientId,
        decidedAt: new Date(),
      })
      .where(eq(schema.incomingPayments.id, inc.id));
    if (opts.linkStripeCustomer && inc.stripeCustomerId && clientIds.size === 1) {
      await tx
        .update(schema.clients)
        .set({ stripeCustomerId: inc.stripeCustomerId })
        .where(and(eq(schema.clients.id, [...clientIds][0]), dsql`${schema.clients.stripeCustomerId} is null`));
    }
    return added;
  });
}

const monthLabelShort = (period: string) =>
  new Date(`${period}T12:00:00Z`).toLocaleDateString("en-IE", { month: "short", year: "numeric", timeZone: "UTC" });

/** The payment row a part points at, creating the client's retainer row for that month when there isn't one. */
async function resolveRow(tx: Db, part: AssignPart, fallbackAmount: number): Promise<Payment> {
  if (part.paymentId) {
    const [row] = await tx.select().from(schema.payments).where(eq(schema.payments.id, part.paymentId));
    if (!row) throw new Error(`Payment row ${part.paymentId} not found`);
    return row;
  }
  if (!part.clientId || !part.period || !/^\d{4}-\d{2}-01$/.test(part.period)) throw new Error("Choose a month for each part.");
  const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, part.clientId));
  if (!client) throw new Error(`Client ${part.clientId} not found`);
  const existing = await tx
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.clientId, client.id), eq(schema.payments.period, part.period)))
    .orderBy(asc(schema.payments.id));
  const open = existing.find((r) => r.amountCollected < r.amountDue - 0.005);
  if (open) return open;
  if (existing.length) return existing[0]; // already paid: the caller reports it
  const due = client.retainerExVat > 0 ? amountDue(client) : round2(fallbackAmount);
  const [row] = await tx
    .insert(schema.payments)
    .values({ clientId: client.id, label: "Retainer", period: part.period, amountDue: due, dueDate: part.period, method: client.billingMethod })
    .returning();
  return row;
}

/**
 * Takes back money that incoming payments had put on a payment row (when the owner unticks it), so the
 * payment shows up again under "to assign" and can go to the right month. Returns how much was released.
 */
export async function releaseAllocations(tx: Db, paymentId: number): Promise<number> {
  const items = await tx
    .select()
    .from(schema.incomingPayments)
    .where(dsql`${schema.incomingPayments.allocations} @> ${JSON.stringify([{ paymentId }])}::jsonb`)
    .for("update");
  let released = 0;
  for (const inc of items) {
    const keep = inc.allocations.filter((a) => a.paymentId !== paymentId);
    released = round2(released + inc.allocations.filter((a) => a.paymentId === paymentId).reduce((s, a) => s + a.amount, 0));
    const allocated = round2(keep.reduce((s, a) => s + a.amount, 0));
    await tx
      .update(schema.incomingPayments)
      .set({ allocations: keep, allocated, status: allocated >= inc.amount - 0.005 ? "matched" : "unmatched", decidedAt: keep.length ? inc.decidedAt : null })
      .where(eq(schema.incomingPayments.id, inc.id));
  }
  return released;
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
