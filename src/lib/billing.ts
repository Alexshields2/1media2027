import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { addMonths, monthStart, today, daysBetween } from "./dates";
import type { Client, Payment } from "../db/schema";

/** What a client actually pays per month, given their VAT setting. */
export function amountDue(c: Pick<Client, "retainerExVat" | "vat">): number {
  const base = c.retainerExVat;
  return c.vat === "plus" ? round2(base * (1 + config.vatRate)) : base;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PaymentState = "paid" | "part" | "overdue" | "due" | "upcoming";

export function paymentState(p: Pick<Payment, "amountDue" | "amountCollected" | "dueDate">, on = today()): PaymentState {
  if (p.amountCollected >= p.amountDue - 0.005) return "paid";
  if (p.amountCollected > 0) return "part";
  const d = daysBetween(p.dueDate, on);
  if (d > 0) return "overdue";
  if (d === 0) return "due";
  return "upcoming";
}

/** Payment tracking started in January 2026; used when there is no real payment history yet. */
export const TRACKING_START = "2026-01-01";

/**
 * The first month with real payment data: money collected or imported from Notion. Rows that were only generated
 * (never paid, never imported) don't count, so a stray "Generate rows" click for an old month can't move it earlier.
 */
export async function trackingStart(): Promise<string> {
  const [r] = await db
    .select({ min: dsql<string | null>`min(${schema.payments.period})::text` })
    .from(schema.payments)
    .where(dsql`${schema.payments.amountCollected} > 0 or ${schema.payments.notionPageId} is not null`);
  return r?.min ? monthStart(r.min) : TRACKING_START;
}

/** The rows generateMonth would create for a month: how many and their total. */
export async function previewMonth(period: string = monthStart()): Promise<{ count: number; total: number }> {
  const p = monthStart(period);
  const [active, existing] = await Promise.all([
    db.select().from(schema.clients).where(inArray(schema.clients.status, ["active", "onboarding"])),
    db.select({ clientId: schema.payments.clientId }).from(schema.payments).where(and(eq(schema.payments.period, p), eq(schema.payments.label, "Retainer"))),
  ]);
  const has = new Set(existing.map((e) => e.clientId));
  const todo = active.filter((c) => c.retainerExVat > 0 && !has.has(c.id));
  return { count: todo.length, total: round2(todo.reduce((s, c) => s + amountDue(c), 0)) };
}

/**
 * Creates the month's retainer row for every active client that doesn't have one yet.
 * Safe to run repeatedly. Returns how many rows were created.
 */
export async function generateMonth(period: string = monthStart()): Promise<number> {
  const p = monthStart(period);
  const active = await db.select().from(schema.clients).where(inArray(schema.clients.status, ["active", "onboarding"]));
  const rows = active
    .filter((c) => c.retainerExVat > 0)
    .map((c) => ({
      clientId: c.id,
      label: "Retainer",
      period: p,
      amountDue: amountDue(c),
      dueDate: p,
      method: c.billingMethod,
    }));
  if (!rows.length) return 0;
  const inserted = await db.insert(schema.payments).values(rows).onConflictDoNothing().returning({ id: schema.payments.id });
  return inserted.length;
}

export async function recordPayment(
  paymentId: number,
  data: { amount: number; paidDate?: string; method?: Payment["method"]; note?: string; stripeInvoiceId?: string },
) {
  const [p] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
  if (!p) throw new Error(`Payment ${paymentId} not found`);
  const notes = [p.notes, data.note].filter(Boolean).join("\n") || null;
  await db
    .update(schema.payments)
    .set({
      amountCollected: round2(data.amount),
      paidDate: data.paidDate ?? today(),
      method: data.method ?? p.method,
      notes,
      stripeInvoiceId: data.stripeInvoiceId ?? p.stripeInvoiceId,
    })
    .where(eq(schema.payments.id, paymentId));
}

/** Month totals for the dashboard. */
export async function monthTotals(period: string = monthStart()) {
  const rows = await db.select().from(schema.payments).where(eq(schema.payments.period, monthStart(period)));
  const due = rows.reduce((s, r) => s + r.amountDue, 0);
  const collected = rows.reduce((s, r) => s + r.amountCollected, 0);
  return { due: round2(due), collected: round2(collected), outstanding: round2(due - collected), count: rows.length };
}

/** Everything owed with a due date in the past, oldest first. */
export async function overdue() {
  const rows = await db
    .select({ p: schema.payments, client: schema.clients.name })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(and(dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`, dsql`${schema.payments.dueDate} < ${today()}`))
    .orderBy(schema.payments.dueDate);
  return rows.map((r) => ({ ...r.p, client: r.client, owed: round2(r.p.amountDue - r.p.amountCollected), days: daysBetween(r.p.dueDate, today()) }));
}

export async function mrr() {
  const active = await db.select().from(schema.clients).where(eq(schema.clients.status, "active"));
  return { exVat: round2(active.reduce((s, c) => s + c.retainerExVat, 0)), clients: active.length };
}

export { addMonths };
