// Helpers for the database tests (imported after the test database is created).
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { generateMonth, paymentState } from "../src/lib/billing";

export { handleStripeEvent } from "../src/lib/stripe-webhook";
export { assignIncoming, assignIncomingParts, ignoreIncoming, importBankCsv, listUnmatched } from "../src/lib/reconcile";
export { editPayment, loadPaymentLog, tickPayments, untickPayments } from "../src/lib/payment-log";
export { SUGGEST_AT } from "../src/lib/matching";
export { paymentState };

/** The demo agency: five clients, October and November rows, October paid for Paving. */
export async function seed() {
  await db.insert(schema.clients).values([
    { name: "Demo Paving Co", retainerExVat: 1500, vat: "plus", billingMethod: "stripe", stripeCustomerId: "cus_DemoPaving", contactName: "Pat", email: "pat@example.com" },
    { name: "Demo Attic Conversions", retainerExVat: 3000, vat: "plus", billingMethod: "invoice", contactName: "Mary", email: "mary@example.com" },
    { name: "Demo Bathrooms", retainerExVat: 406.5, vat: "inc", billingMethod: "invoice", contactName: "John", email: "john@example.com" },
    { name: "Demo Garden Rooms", retainerExVat: 900, vat: "plus", billingMethod: "revolut", contactName: "Aoife", email: "aoife@example.com" },
    { name: "Demo Westside", retainerExVat: 500, vat: "plus", billingMethod: "invoice", contactName: "Ger", email: "ger@example.com" },
    { name: "Demo Windows", retainerExVat: 500, vat: "plus", billingMethod: "invoice", contactName: "Niamh", email: "niamh@example.com" },
  ]);
  await generateMonth("2026-10-01");
  await generateMonth("2026-11-01");
  const paving = await client("Demo Paving Co");
  await db.insert(schema.payments).values({ clientId: paving.id, period: "2026-12-01", amountDue: 1845, dueDate: "2026-12-01" });
  const oct = await row("Demo Paving Co", "2026-10-01");
  await db.update(schema.payments).set({ amountCollected: 1845, paidDate: "2026-10-03", method: "stripe" }).where(eq(schema.payments.id, oct.id));
}

export async function client(name: string) {
  const [c] = await db.select().from(schema.clients).where(eq(schema.clients.name, name));
  if (!c) throw new Error(`no client ${name}`);
  return c;
}

export async function row(clientName: string, period: string) {
  const c = await client(clientName);
  const [p] = await db.select().from(schema.payments).where(and(eq(schema.payments.clientId, c.id), eq(schema.payments.period, period)));
  if (!p) throw new Error(`no row for ${clientName} ${period}`);
  return p;
}

export async function incoming(where: { stripeInvoiceId: string }) {
  return db.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.stripeInvoiceId, where.stripeInvoiceId));
}

export async function setStripeCustomer(name: string, cus: string) {
  await db.update(schema.clients).set({ stripeCustomerId: cus }).where(eq(schema.clients.name, name));
}

/** Reopens a client's rows and forgets money matched to it (so one test's payments don't leak into the next). */
export async function resetClient(name: string) {
  const c = await client(name);
  await db.update(schema.payments).set({ amountCollected: 0, paidDate: null, method: null, notes: null, stripeInvoiceId: null }).where(eq(schema.payments.clientId, c.id));
  await db.delete(schema.incomingPayments).where(eq(schema.incomingPayments.clientId, c.id));
  await db.update(schema.clients).set({ stripeCustomerId: null }).where(eq(schema.clients.id, c.id));
}

/** Every payment row's money fields, to prove something didn't change them. */
export async function paymentSnapshot() {
  const rows = await db.select().from(schema.payments).orderBy(schema.payments.id);
  return rows.map((r) => ({ id: r.id, amountCollected: r.amountCollected, paidDate: r.paidDate, method: r.method, stripeInvoiceId: r.stripeInvoiceId }));
}

export async function incomingById(id: number) {
  const [i] = await db.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.id, id));
  return i;
}

export async function deleteIncoming(stripeInvoiceIds: string[]) {
  for (const id of stripeInvoiceIds) await db.delete(schema.incomingPayments).where(eq(schema.incomingPayments.stripeInvoiceId, id));
}

export async function auditFor(target: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.target, target)).orderBy(schema.auditLog.id);
}

export async function addOwner() {
  const [u] = await db.insert(schema.users).values({ email: "owner@example.com", name: "Owner", role: "owner" }).returning();
  return u;
}
