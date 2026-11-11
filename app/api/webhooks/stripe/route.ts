import { NextResponse, type NextRequest } from "next/server";
import { handleStripeEvent, verifyStripeEvent } from "@/lib/stripe-webhook";

// Stripe -> Developers -> Webhooks: point an endpoint at /api/webhooks/stripe with the events
// invoice.paid, invoice.payment_succeeded, invoice.updated, invoice.payment_failed and charge.refunded.
// Only STRIPE_WEBHOOK_SECRET is needed here (the signing secret, whsec_...). See src/lib/stripe-webhook.ts.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec) return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });

  const body = await req.text();
  let event;
  try {
    event = verifyStripeEvent(body, req.headers.get("stripe-signature"), whsec);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    const r = await handleStripeEvent(event);
    return NextResponse.json({ id: event.id, type: event.type, outcome: r.outcome, duplicate: !!r.duplicate });
  } catch (err) {
    console.error("Stripe webhook failed", event.id, err);
    // 500 makes Stripe retry; nothing was saved because the work runs in one transaction.
    return NextResponse.json({ error: "failed, will retry" }, { status: 500 });
  }
}
