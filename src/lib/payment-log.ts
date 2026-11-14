import { and, asc, eq, gte, inArray, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { audit } from "./audit";
import { amountDue, round2, trackingStart } from "./billing";
import { today as todayIso } from "./dates";
import { releaseAllocations } from "./reconcile";
import { buildPaymentLog, cellState, tickedValues, untickedValues, METHODS, type LogClient, type LogRow, type Method, type PaymentLogData } from "./payment-log-core";

// The payment log: the owner ticks off each client's month as paid. Every change is one transaction and
// leaves an audit row with who did it. Permission checks live in the server actions (app/payments/log-actions.ts).

const rowFields = {
  id: schema.payments.id,
  clientId: schema.payments.clientId,
  label: schema.payments.label,
  period: schema.payments.period,
  amountDue: schema.payments.amountDue,
  amountCollected: schema.payments.amountCollected,
  dueDate: schema.payments.dueDate,
  paidDate: schema.payments.paidDate,
  method: schema.payments.method,
  notes: schema.payments.notes,
};

/** Everything the log grid needs for one year. */
export async function loadPaymentLog(year: number, on = todayIso()): Promise<PaymentLogData> {
  const [clients, rows, [span], from] = await Promise.all([
    db
      .select({ id: schema.clients.id, name: schema.clients.name, status: schema.clients.status, billingMethod: schema.clients.billingMethod, retainerExVat: schema.clients.retainerExVat })
      .from(schema.clients)
      .orderBy(asc(schema.clients.name)),
    db
      .select(rowFields)
      .from(schema.payments)
      .where(and(gte(schema.payments.period, `${year}-01-01`), lte(schema.payments.period, `${year}-12-01`)))
      .orderBy(asc(schema.payments.period), asc(schema.payments.id)),
    db.select({ max: dsql<string | null>`max(${schema.payments.period})::text` }).from(schema.payments),
    trackingStart(),
  ]);
  const thisYear = Number(on.slice(0, 4));
  // Years from the first month with real payment data, never earlier (rows generated for older months by mistake don't count).
  const first = Math.min(Number(from.slice(0, 4)), thisYear);
  const last = Math.max(span?.max ? Number(span.max.slice(0, 4)) : thisYear, thisYear, year);
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  return buildPaymentLog(clients as LogClient[], rows as LogRow[], year, on, years, from);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockRow(tx: Tx, id: number) {
  const [r] = await tx
    .select({ p: schema.payments, billingMethod: schema.clients.billingMethod, clientName: schema.clients.name })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(eq(schema.payments.id, id))
    .for("update", { of: schema.payments });
  if (!r) throw new Error(`Payment ${id} not found`);
  return r;
}

const snapshot = (p: typeof schema.payments.$inferSelect) => ({ amountCollected: p.amountCollected, paidDate: p.paidDate, method: p.method });

/** Ticks rows as paid in full. Rows already paid are left alone. Returns the ids that changed. */
export async function tickPayments(ids: number[], userId: number | null, on = todayIso()): Promise<number[]> {
  const changed: { id: number; before: ReturnType<typeof snapshot>; after: ReturnType<typeof tickedValues>; client: string; period: string; label: string }[] = [];
  await db.transaction(async (tx) => {
    for (const id of ids) {
      const { p, billingMethod, clientName } = await lockRow(tx, id);
      if (cellState(p) === "paid" || cellState(p) === "none") continue;
      const after = tickedValues(p, { billingMethod }, on);
      await tx.update(schema.payments).set(after).where(eq(schema.payments.id, id));
      changed.push({ id, before: snapshot(p), after, client: clientName, period: p.period, label: p.label });
    }
  });
  for (const c of changed) {
    await audit("payment.record", { userId, target: `payment:${c.id}`, detail: { via: "payment log", change: "ticked paid in full", client: c.client, month: c.period, line: c.label, before: c.before, after: c.after } });
  }
  return changed.map((c) => c.id);
}

/**
 * Sets rows back to unpaid. Money an incoming payment (Stripe or bank) had put on the row is released, so that
 * payment shows up again under "to assign". Returns the ids that changed.
 */
export async function untickPayments(ids: number[], userId: number | null): Promise<number[]> {
  const changed: { id: number; before: ReturnType<typeof snapshot>; released: number; client: string; period: string; label: string }[] = [];
  await db.transaction(async (tx) => {
    for (const id of ids) {
      const { p, clientName } = await lockRow(tx, id);
      if (p.amountCollected <= 0.005 && !p.paidDate) continue;
      await tx.update(schema.payments).set(untickedValues).where(eq(schema.payments.id, id));
      const released = await releaseAllocations(tx, id);
      changed.push({ id, before: snapshot(p), released, client: clientName, period: p.period, label: p.label });
    }
  });
  for (const c of changed) {
    await audit("payment.unrecord", { userId, target: `payment:${c.id}`, detail: { via: "payment log", change: "unticked (set back to unpaid)", client: c.client, month: c.period, line: c.label, before: c.before, releasedFromIncoming: c.released } });
  }
  return changed.map((c) => c.id);
}

export interface PaymentEdit {
  amountCollected: number;
  paidDate: string | null;
  method: Method | null;
  notes: string | null;
}

/** The small editor: part payment, date paid, method, note. Exact values, not added on. */
export async function editPayment(id: number, edit: PaymentEdit, userId: number | null) {
  if (!Number.isFinite(edit.amountCollected) || edit.amountCollected < 0) throw new Error("Amount collected can't be negative.");
  if (edit.paidDate && !/^\d{4}-\d{2}-\d{2}$/.test(edit.paidDate)) throw new Error("Date paid must be a date.");
  if (edit.method && !METHODS.includes(edit.method)) throw new Error("Unknown payment method.");
  const result = await db.transaction(async (tx) => {
    const { p, clientName } = await lockRow(tx, id);
    const amount = round2(edit.amountCollected);
    if (amount > p.amountDue + 0.005) throw new Error(`That's more than the €${p.amountDue} due. Put the extra on another month.`);
    const after = {
      amountCollected: amount,
      paidDate: amount > 0 ? (edit.paidDate ?? p.paidDate ?? todayIso()) : null,
      method: edit.method,
      notes: edit.notes?.trim() || null,
    };
    await tx.update(schema.payments).set(after).where(eq(schema.payments.id, id));
    const released = amount <= 0.005 && p.amountCollected > 0.005 ? await releaseAllocations(tx, id) : 0;
    return { before: { ...snapshot(p), notes: p.notes }, after, released, client: clientName, period: p.period, label: p.label };
  });
  await audit(result.after.amountCollected > 0 || result.before.amountCollected <= 0 ? "payment.record" : "payment.unrecord", {
    userId,
    target: `payment:${id}`,
    detail: { via: "payment log", change: "edited", client: result.client, month: result.period, line: result.label, before: result.before, after: result.after, releasedFromIncoming: result.released },
  });
}

/** Months a payment could go to, per client: open rows (any year) plus the next three months that have no row yet. */
export async function assignTargets(on = todayIso()) {
  const clients = await db
    .select({ id: schema.clients.id, name: schema.clients.name, status: schema.clients.status, billingMethod: schema.clients.billingMethod, retainerExVat: schema.clients.retainerExVat, vat: schema.clients.vat })
    .from(schema.clients)
    .orderBy(asc(schema.clients.name));
  const thisMonth = `${on.slice(0, 7)}-01`;
  const ahead = [1, 2, 3].map((n) => {
    const [y, m] = thisMonth.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
  });
  const rows = await db
    .select(rowFields)
    .from(schema.payments)
    .where(dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue} or ${schema.payments.period} >= ${thisMonth}`)
    .orderBy(asc(schema.payments.period), asc(schema.payments.id));
  return clients.map((c) => {
    const mine = rows.filter((r) => r.clientId === c.id);
    const open = mine
      .filter((r) => r.amountCollected < r.amountDue - 0.005)
      .map((r) => ({ paymentId: r.id, period: r.period, label: r.label, owed: round2(r.amountDue - r.amountCollected), exists: true as const }));
    const future =
      c.retainerExVat > 0
        ? ahead.filter((p) => !mine.some((r) => r.period === p)).map((p) => ({ period: p, label: "Retainer", owed: amountDue(c), exists: false as const }))
        : [];
    return { clientId: c.id, name: c.name, status: c.status, options: [...open, ...future].sort((a, b) => a.period.localeCompare(b.period)) };
  });
}

export async function bankCreditsWaiting(): Promise<number> {
  const [r] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.incomingPayments)
    .where(and(eq(schema.incomingPayments.source, "bank"), inArray(schema.incomingPayments.status, ["unmatched"])));
  return r?.n ?? 0;
}
