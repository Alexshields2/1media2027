import Stripe from "stripe";
import { and, desc, eq, gt, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { round2 } from "./billing";
import { eur, monthStart } from "./dates";
import { appendNote, openRows, type Db } from "./reconcile";
import { suggestMatches } from "./matching";
import { notify } from "./slack";

// Stripe webhook reconciliation.
//
// Events handled (subscribe to these in Stripe -> Developers -> Webhooks):
//   invoice.paid, invoice.payment_succeeded, invoice.updated  money in (full or part payments)
//   invoice.payment_failed                                     note on the row + Slack
//   charge.refunded                                            note on the row + Slack (we never issue refunds)
//
// Money in is NEVER applied to a payment row here. Each payment is recorded as an incoming payment waiting for
// the owner (status "unmatched", with the client when the Stripe customer is known and suggested months), and the
// owner ticks off which month(s) it covers in the payment log. Clients pay ahead and pay late, so only they know.
//
// Idempotency: every event ID is stored in stripe_events inside the same transaction as its effects,
// so a retried event is a no-op. Money is tracked per invoice as a cumulative amount, so overlapping
// events for one invoice (invoice.paid + invoice.payment_succeeded) only ever apply the difference.

export type HandleResult = { outcome: string; duplicate?: boolean; slack?: string[] };

/** Verifies the Stripe-Signature header. Throws on a bad or missing signature. */
export function verifyStripeEvent(body: string, signature: string | null, secret: string): Stripe.Event {
  return Stripe.webhooks.constructEvent(body, signature ?? "", secret);
}

const dublinDate = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: config.timezone });
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

export interface InvoiceFacts {
  id: string;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  amountDue: number;
  amountPaid: number;
  paidDate: string;
  /** Month the invoice is for (first line's service period, else the invoice date). */
  period: string;
  paymentIntentId: string | null;
}

/** The fields we need from a Stripe invoice, in euros and Dublin dates. */
export function invoiceFacts(inv: Stripe.Invoice, eventCreated: number): InvoiceFacts {
  const line = inv.lines?.data?.[0];
  const periodTs = line?.period?.start ?? inv.created ?? eventCreated;
  const legacyPi = (inv as unknown as { payment_intent?: string | { id: string } | null }).payment_intent;
  const pi = inv.payments?.data?.find((p) => p.payment?.payment_intent)?.payment?.payment_intent ?? legacyPi ?? null;
  return {
    id: inv.id ?? "",
    number: inv.number ?? null,
    customerId: idOf(inv.customer as string | { id: string } | null),
    customerName: inv.customer_name ?? null,
    customerEmail: inv.customer_email ?? null,
    currency: (inv.currency ?? "eur").toUpperCase(),
    amountDue: round2((inv.amount_due ?? 0) / 100),
    amountPaid: round2((inv.amount_paid ?? 0) / 100),
    paidDate: dublinDate(inv.status_transitions?.paid_at ?? eventCreated),
    period: monthStart(dublinDate(periodTs)),
    paymentIntentId: idOf(pi as string | { id: string } | null),
  };
}

/** Handles one verified event. Throws on failure so the route answers 500 and Stripe retries. */
export async function handleStripeEvent(event: Stripe.Event): Promise<HandleResult> {
  const result = await db.transaction(async (tx) => {
    const [fresh] = await tx.insert(schema.stripeEvents).values({ id: event.id, type: event.type, outcome: "processing" }).onConflictDoNothing().returning();
    if (!fresh) return { outcome: "duplicate event, already handled", duplicate: true } as HandleResult;
    let r: HandleResult;
    switch (event.type) {
      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.updated":
        r = await onInvoicePayment(tx, event.data.object as Stripe.Invoice, event.created);
        break;
      case "invoice.payment_failed":
        r = await onPaymentFailed(tx, event.data.object as Stripe.Invoice, event.created);
        break;
      case "charge.refunded":
        r = await onRefund(tx, event.data.object as Stripe.Charge);
        break;
      default:
        r = { outcome: `ignored ${event.type}` };
    }
    await tx.update(schema.stripeEvents).set({ outcome: r.outcome.slice(0, 500) }).where(eq(schema.stripeEvents.id, event.id));
    return r;
  });
  // Slack only after the transaction committed.
  for (const m of result.slack ?? []) await notify(m);
  return result;
}

async function clientByCustomer(tx: Db, customerId: string | null) {
  if (!customerId) return undefined;
  const [c] = await tx.select().from(schema.clients).where(eq(schema.clients.stripeCustomerId, customerId));
  return c;
}

async function onInvoicePayment(tx: Db, inv: Stripe.Invoice, created: number): Promise<HandleResult> {
  const f = invoiceFacts(inv, created);
  if (!f.id || f.amountPaid <= 0) return { outcome: "no money paid on this invoice yet" };

  // Serialise work per invoice, then only record money we haven't seen for it.
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext(${f.id}))`);
  const [{ seen }] = await tx
    .select({ seen: dsql<string>`coalesce(sum(${schema.incomingPayments.amount}), 0)` })
    .from(schema.incomingPayments)
    .where(and(eq(schema.incomingPayments.source, "stripe"), eq(schema.incomingPayments.stripeInvoiceId, f.id)));
  const delta = round2(f.amountPaid - Number(seen));
  if (delta <= 0.005) return { outcome: `invoice ${f.id} already recorded (${eur(f.amountPaid)})` };

  const part = f.amountPaid < f.amountDue - 0.005;
  const [incoming] = await tx
    .insert(schema.incomingPayments)
    .values({
      source: "stripe",
      externalId: `${f.id}@${Math.round(f.amountPaid * 100)}`,
      receivedDate: f.paidDate,
      amount: delta,
      currency: f.currency,
      payer: f.customerName ?? f.customerEmail,
      reference: f.number,
      description: `Stripe invoice ${f.number ?? f.id}${part ? ` (part payment: ${eur(f.amountPaid)} of ${eur(f.amountDue)})` : ""}`,
      stripeCustomerId: f.customerId,
      stripeInvoiceId: f.id,
      stripePaymentIntentId: f.paymentIntentId,
    })
    .returning();

  if (f.currency !== "EUR") {
    await tx.update(schema.incomingPayments).set({ notes: `Paid in ${f.currency}: check the amount in euro before assigning it.` }).where(eq(schema.incomingPayments.id, incoming.id));
    return { outcome: `to assign: ${f.currency} payment`, slack: [`Stripe payment of ${delta} ${f.currency} (invoice ${f.number ?? f.id}) is not in EUR. Assign it on the Payments page.`] };
  }

  // Never applied automatically: clients pay a month or two ahead, or pay back months late, so the owner
  // decides which month(s) it covers. We only work out who it's from and suggest the likely months.
  const client = await clientByCustomer(tx, f.customerId);
  const all = await openRows(tx);
  const pool = client ? all.filter((r) => r.clientId === client.id) : all;
  const suggestions = suggestMatches(
    { date: f.paidDate, amount: delta, payer: client?.name ?? f.customerName, reference: [f.number, f.customerEmail].filter(Boolean).join(" "), channel: "stripe" },
    pool,
  );
  await tx
    .update(schema.incomingPayments)
    .set({
      clientId: client?.id ?? null,
      suggestions,
      notes: client ? null : `No client has Stripe customer ${f.customerId ?? "?"}. Pick the client when you assign it (you can save the customer ID on them).`,
    })
    .where(eq(schema.incomingPayments.id, incoming.id));
  const who = client?.name ?? f.customerName ?? f.customerEmail ?? f.customerId ?? "unknown customer";
  return {
    outcome: `to assign: ${eur(delta)} from ${who}${client ? " (client known by Stripe customer)" : ""}`,
    slack: [`${who} paid ${eur(delta)} via Stripe${part ? " (part payment)" : ""}. Tick off which month(s) it covers under "Stripe payments to assign" on the Payments page.`],
  };
}

async function onPaymentFailed(tx: Db, inv: Stripe.Invoice, created: number): Promise<HandleResult> {
  const f = invoiceFacts(inv, created);
  const when = dublinDate(created);
  const note = `Stripe payment failed ${when} on invoice ${f.number ?? f.id} (${eur(round2(f.amountDue - f.amountPaid))} due${inv.attempt_count ? `, attempt ${inv.attempt_count}` : ""})`;
  const client = await clientByCustomer(tx, f.customerId);
  if (!client) {
    return { outcome: "payment failed, no client for customer", slack: [`Stripe payment failed for ${f.customerName ?? f.customerId} (invoice ${f.number ?? f.id}); no client has that Stripe customer ID.`] };
  }
  const rows = await openRows(tx, { clientId: client.id });
  const target = rows.find((r) => r.stripeInvoiceId === f.id) ?? rows.find((r) => r.period === f.period) ?? rows[0];
  if (target) await appendNote(tx, target.id, note);
  return { outcome: `payment failed noted for ${client.name}${target ? ` (row ${target.id})` : ""}`, slack: [`${client.name}: ${note}.`] };
}

async function onRefund(tx: Db, ch: Stripe.Charge): Promise<HandleResult> {
  const amount = round2((ch.amount_refunded ?? 0) / 100);
  const note = `Stripe refund: ${eur(amount)} of charge ${ch.id} refunded in Stripe (${dublinDate(ch.created)}). Not deducted here: check and adjust by hand.`;
  const pi = idOf(ch.payment_intent as string | { id: string } | null);
  const rowIds = new Set<number>();
  if (pi) {
    const inc = await tx.select().from(schema.incomingPayments).where(eq(schema.incomingPayments.stripePaymentIntentId, pi));
    for (const i of inc) for (const a of i.allocations) rowIds.add(a.paymentId);
  }
  const client = await clientByCustomer(tx, idOf(ch.customer as string | { id: string } | null));
  if (!rowIds.size && client) {
    const [last] = await tx
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(and(eq(schema.payments.clientId, client.id), eq(schema.payments.method, "stripe"), gt(schema.payments.amountCollected, 0)))
      .orderBy(desc(schema.payments.paidDate))
      .limit(1);
    if (last) rowIds.add(last.id);
  }
  for (const id of rowIds) await appendNote(tx, id, note);
  const who = client?.name ?? ch.billing_details?.name ?? idOf(ch.customer as string | null) ?? "unknown customer";
  return {
    outcome: `refund noted on ${rowIds.size} row(s)`,
    slack: [`Refund of ${eur(amount)} for ${who} was made in Stripe. 1Media OS only notes it${rowIds.size ? " on the payment row" : " (no matching row found)"}; adjust the amount collected by hand if needed.`],
  };
}
