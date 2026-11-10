import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";
import { and, asc, eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordPayment, round2 } from "@/lib/billing";
import { notify } from "@/lib/slack";
import { eur } from "@/lib/dates";

// Stripe -> Developers -> Webhooks: point an endpoint at /api/webhooks/stripe with the
// event "invoice.paid". Each paid invoice is applied to the client's oldest unpaid rows.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const key = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whsec) return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });

  const stripe = new Stripe(key);
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, req.headers.get("stripe-signature") ?? "", whsec);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  if (event.type !== "invoice.paid") return NextResponse.json({ ignored: event.type });

  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  const amount = (invoice.amount_paid ?? 0) / 100;
  if (!customerId || amount <= 0) return NextResponse.json({ ignored: "no customer or amount" });

  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.stripeCustomerId, customerId));
  if (!client) {
    await notify(`Stripe payment of ${eur(amount)} from customer ${customerId} doesn't match any client. Add the Stripe customer ID to the client in 1Media OS.`);
    return NextResponse.json({ unmatched: customerId });
  }

  // Idempotent: skip if this invoice was already applied.
  const already = await db.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.stripeInvoiceId, invoice.id ?? ""));
  if (already.length) return NextResponse.json({ duplicate: invoice.id });

  const open = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.clientId, client.id), dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`))
    .orderBy(asc(schema.payments.dueDate));

  let left = amount;
  const paidOn = new Date(((invoice.status_transitions?.paid_at ?? Date.now() / 1000) as number) * 1000).toISOString().slice(0, 10);
  for (const p of open) {
    if (left <= 0.005) break;
    const apply = Math.min(left, round2(p.amountDue - p.amountCollected));
    await recordPayment(p.id, {
      amount: round2(p.amountCollected + apply),
      paidDate: paidOn,
      method: "stripe",
      note: `Stripe invoice ${invoice.number ?? invoice.id} paid ${paidOn}`,
      stripeInvoiceId: invoice.id ?? undefined,
    });
    left = round2(left - apply);
  }

  await notify(`${client.name} paid ${eur(amount)} via Stripe${left > 0.005 ? ` (${eur(left)} not matched to any open month)` : ""}.`);
  return NextResponse.json({ client: client.name, applied: round2(amount - left), unapplied: left });
}
