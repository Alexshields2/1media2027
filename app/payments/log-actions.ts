"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { audit } from "@/lib/audit";
import { editPayment, tickPayments, untickPayments } from "@/lib/payment-log";
import { assignIncomingParts, ignoreIncoming } from "@/lib/reconcile";
import { METHODS } from "@/lib/payment-log-core";

// Server actions for the payment log. Every one checks the "payments" permission on the server (owners only);
// the page's optimistic ticks are only a preview, and these results are the source of truth.

export type LogResult = { ok: true } | { ok: false; error: string };

const ids = z.array(z.number().int().positive()).min(1).max(50);

function done(): LogResult {
  revalidatePath("/payments");
  revalidatePath("/");
  return { ok: true };
}

const fail = (e: unknown): LogResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function tickAction(paymentIds: number[]): Promise<LogResult> {
  const user = await requirePermission("payments", "record payments");
  try {
    await tickPayments(ids.parse(paymentIds), user.id);
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function untickAction(paymentIds: number[]): Promise<LogResult> {
  const user = await requirePermission("payments", "change payments");
  try {
    await untickPayments(ids.parse(paymentIds), user.id);
  } catch (e) {
    return fail(e);
  }
  return done();
}

const editSchema = z.object({
  paymentId: z.number().int().positive(),
  amountCollected: z.number().min(0),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  method: z.enum(METHODS as [string, ...string[]]).nullable(),
  notes: z.string().max(2000).nullable(),
});

export async function editPaymentAction(input: z.input<typeof editSchema>): Promise<LogResult> {
  const user = await requirePermission("payments", "record payments");
  try {
    const e = editSchema.parse(input);
    await editPayment(e.paymentId, { amountCollected: e.amountCollected, paidDate: e.paidDate, method: e.method as never, notes: e.notes }, user.id);
  } catch (e) {
    return fail(e);
  }
  return done();
}

const partsSchema = z
  .array(
    z.object({
      paymentId: z.number().int().positive().optional(),
      clientId: z.number().int().positive().optional(),
      period: z.string().regex(/^\d{4}-\d{2}-01$/).optional(),
      amount: z.number().positive().optional(),
    }),
  )
  .min(1)
  .max(12);

/** Applies a Stripe (or bank) payment to the month(s) the owner picked, split across months if they like. */
export async function assignPaymentAction(incomingId: number, parts: z.input<typeof partsSchema>, linkStripeCustomer = false): Promise<LogResult> {
  const user = await requirePermission("payments", "assign payments");
  try {
    const id = z.number().int().positive().parse(incomingId);
    const added = await assignIncomingParts(id, partsSchema.parse(parts), { linkStripeCustomer });
    await audit("payment.assign", { userId: user.id, target: `incoming:${id}`, detail: { via: "payment log", allocations: added, linkStripeCustomer } });
  } catch (e) {
    return fail(e);
  }
  return done();
}

export async function ignorePaymentAction(incomingId: number): Promise<LogResult> {
  const user = await requirePermission("payments", "change payments");
  try {
    const id = z.number().int().positive().parse(incomingId);
    await ignoreIncoming(id);
    await audit("payment.assign", { userId: user.id, target: `incoming:${id}`, detail: { via: "payment log", ignored: true } });
  } catch (e) {
    return fail(e);
  }
  return done();
}
