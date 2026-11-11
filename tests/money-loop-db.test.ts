import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { createTestDb, dropTestDb, fixture, skipReason, stripeFixture } from "./helpers/test-db";

// End to end against a throwaway Postgres database: Stripe event fixtures and bank CSV fixtures
// end up reconciled on the right payment rows. Run with TEST_DATABASE_URL set (see helpers/test-db.ts).

describe("money loop (database)", { skip: skipReason }, () => {
  let m: typeof import("./money-loop-db.lib");

  before(async () => {
    await createTestDb();
    delete process.env.SLACK_WEBHOOK_URL;
    m = await import("./money-loop-db.lib");
    await m.seed();
  });
  after(dropTestDb);

  const ev = (name: string) => stripeFixture<Stripe.Event>(name);

  test("Stripe invoice.paid: matched by customer, row paid, idempotent on retry and on overlapping events", async () => {
    const r1 = await m.handleStripeEvent(ev("invoice.paid"));
    assert.match(r1.outcome, /matched by customer to Demo Paving Co/);
    const row = await m.row("Demo Paving Co", "2026-11-01");
    assert.equal(row.amountCollected, 1845);
    assert.equal(row.paidDate, "2026-11-05");
    assert.equal(row.method, "stripe");
    assert.equal(row.stripeInvoiceId, "in_DemoPavingNov");
    assert.match(row.notes ?? "", /Stripe invoice 1M-0042 paid 2026-11-05/);

    // Stripe retries the same event.
    const r2 = await m.handleStripeEvent(ev("invoice.paid"));
    assert.equal(r2.duplicate, true);
    // A different event for the same invoice (invoice.payment_succeeded) adds nothing.
    const r3 = await m.handleStripeEvent(ev("invoice.payment_succeeded"));
    assert.match(r3.outcome, /already recorded/);
    assert.equal((await m.row("Demo Paving Co", "2026-11-01")).amountCollected, 1845);
    assert.equal((await m.incoming({ stripeInvoiceId: "in_DemoPavingNov" })).length, 1);
    // October was already paid and stays untouched.
    assert.equal((await m.row("Demo Paving Co", "2026-10-01")).amountCollected, 1845);
  });

  test("concurrent deliveries of the same event apply the money once", async () => {
    const e = { ...ev("invoice.paid.after-partial"), id: "evt_concurrent_test" } as Stripe.Event;
    // Use a fresh invoice so this test doesn't depend on order: same payload, new invoice ID.
    (e.data.object as Stripe.Invoice).id = "in_ConcurrentAttic";
    (e.data.object as Stripe.Invoice).customer = "cus_Concurrent";
    await m.setStripeCustomer("Demo Bathrooms", "cus_Concurrent");
    const results = await Promise.all([m.handleStripeEvent(e), m.handleStripeEvent(e), m.handleStripeEvent(e)]);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    const inc = await m.incoming({ stripeInvoiceId: "in_ConcurrentAttic" });
    assert.equal(inc.length, 1);
    // Bathrooms owes 406.50 x 2 (Oct, Nov): 813 applied, the rest stays unmatched for the owner.
    assert.equal(inc[0].allocated, 813);
    assert.equal(inc[0].status, "unmatched");
    assert.match(inc[0].notes ?? "", /more than Demo Bathrooms's open rows/);
    await m.resetClient("Demo Bathrooms");
  });

  test("partial payment then full payment: each applies only the new money", async () => {
    await m.setStripeCustomer("Demo Attic Conversions", "cus_DemoAttic");
    const p = await m.handleStripeEvent(ev("invoice.updated.partial"));
    assert.match(p.outcome, /1,000/);
    let row = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.equal(row.amountCollected, 1000);
    assert.equal(m.paymentState(row, "2026-11-11"), "part");
    assert.match(row.notes ?? "", /part payment/);

    await m.handleStripeEvent(ev("invoice.paid.after-partial"));
    row = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.equal(row.amountCollected, 3690);
    assert.equal(row.paidDate, "2026-11-08");
    const inc = await m.incoming({ stripeInvoiceId: "in_DemoAtticNov" });
    assert.deepEqual(inc.map((i) => i.amount).sort((a, b) => a - b), [1000, 2690]);
  });

  test("unknown customer: matched by amount + month when exactly one row fits", async () => {
    const r = await m.handleStripeEvent(ev("invoice.paid.unknown-customer"));
    assert.match(r.outcome, /amount\+period to Demo Garden Rooms/);
    assert.equal((await m.row("Demo Garden Rooms", "2026-11-01")).amountCollected, 1107);
    const [inc] = await m.incoming({ stripeInvoiceId: "in_NewGardenNov" });
    assert.equal(inc.matchedBy, "amount-period");
    assert.match(inc.notes ?? "", /Add Stripe customer cus_NewGarden/);
  });

  test("no match lands in Unmatched; one-click assignment applies it and links the customer", async () => {
    const r = await m.handleStripeEvent(ev("invoice.paid.unmatched"));
    assert.match(r.outcome, /unmatched/);
    const list = await m.listUnmatched();
    const item = list.find((u) => u.stripeInvoiceId === "in_MysteryNov");
    assert.ok(item);
    assert.equal(item.remaining, 615);

    const target = await m.row("Demo Westside", "2026-11-01");
    await m.assignIncoming(item.id, target.id, { linkStripeCustomer: true });
    assert.equal((await m.row("Demo Westside", "2026-11-01")).amountCollected, 615);
    assert.equal((await m.client("Demo Westside")).stripeCustomerId, "cus_Mystery");
    assert.ok(!(await m.listUnmatched()).some((u) => u.id === item.id));
    await assert.rejects(m.assignIncoming(item.id, target.id), /already fully assigned/);
  });

  test("payment failed and refund are notes only; money is never moved", async () => {
    const dec = await m.row("Demo Paving Co", "2026-12-01");
    await m.handleStripeEvent(ev("invoice.payment_failed"));
    const after = await m.row("Demo Paving Co", "2026-12-01");
    assert.equal(after.amountCollected, dec.amountCollected);
    assert.match(after.notes ?? "", /Stripe payment failed 2026-11-09 on invoice 1M-0050/);

    await m.handleStripeEvent(ev("charge.refunded"));
    const nov = await m.row("Demo Paving Co", "2026-11-01");
    assert.equal(nov.amountCollected, 1845, "refunds are not deducted automatically");
    assert.match(nov.notes ?? "", /Stripe refund: €200 of charge ch_DemoPavingNov/);
    // Retried refund event doesn't add a second note.
    await m.handleStripeEvent(ev("charge.refunded"));
    assert.equal(((await m.row("Demo Paving Co", "2026-11-01")).notes ?? "").match(/Stripe refund/g)?.length, 1);
  });

  test("bank CSVs: credits imported with suggestions, nothing applied until the owner confirms", async () => {
    await m.resetClient("Demo Garden Rooms"); // Nov was paid by Stripe above; reopen it for the bank test
    const rev = await m.importBankCsv(fixture("bank/revolut-business.csv"), { fileName: "revolut-nov.csv" });
    assert.deepEqual({ credits: rev.credits, inserted: rev.inserted, skipped: rev.skipped }, { credits: 3, inserted: 3, skipped: 3 });
    assert.equal(rev.suggested, 2);
    // Not auto-confirmed.
    assert.equal((await m.row("Demo Garden Rooms", "2026-11-01")).amountCollected, 0);
    assert.equal((await m.row("Demo Bathrooms", "2026-10-01")).amountCollected, 0);

    // Re-uploading the same export is a no-op.
    const again = await m.importBankCsv(fixture("bank/revolut-business.csv"));
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicates, 3);

    const aib = await m.importBankCsv(fixture("bank/aib.csv"), { fileName: "aib-nov.csv" });
    assert.deepEqual({ credits: aib.credits, inserted: aib.inserted, suggested: aib.suggested }, { credits: 2, inserted: 2, suggested: 1 });
    // Attic's November was paid by Stripe above, so the "1MEDIA NOV" credit is suggested for the still-open
    // October row, with the month mismatch spelled out for the owner.
    const atticCredit = (await m.listUnmatched()).find((u) => u.amount === 3690)!;
    assert.equal(atticCredit.live[0].paymentId, (await m.row("Demo Attic Conversions", "2026-10-01")).id);
    assert.ok(atticCredit.live[0].reasons.includes("mentions nov, not oct"));

    const list = await m.listUnmatched();
    const garden = list.find((u) => u.payer === "AOIFE BYRNE")!;
    const bath = list.find((u) => u.payer === "DEMO BATHROOMS LTD")!;
    const smith = list.find((u) => u.payer === "J SMITH")!;
    const gardenRow = await m.row("Demo Garden Rooms", "2026-11-01");
    const bathOct = await m.row("Demo Bathrooms", "2026-10-01");
    assert.equal(garden.live[0].paymentId, gardenRow.id);
    assert.ok(garden.live[0].score >= m.SUGGEST_AT);
    assert.equal(bath.live[0].paymentId, bathOct.id);
    assert.ok(!smith.live.length || smith.live[0].score < m.SUGGEST_AT);

    // Owner confirms the two suggestions.
    await m.assignIncoming(garden.id, garden.live[0].paymentId);
    await m.assignIncoming(bath.id, bath.live[0].paymentId);
    const g = await m.row("Demo Garden Rooms", "2026-11-01");
    assert.deepEqual([g.amountCollected, g.paidDate, g.method], [1107, "2026-11-06", "revolut"]);
    const b = await m.row("Demo Bathrooms", "2026-10-01");
    assert.deepEqual([b.amountCollected, b.paidDate, b.method], [406.5, "2026-11-07", "revolut"]);
    assert.match(b.notes ?? "", /revolut credit of €406.50 on 2026-11-07 \(DEMO BATHROOMS LTD \/ 1MEDIA OCT\) assigned by owner/);

    // The interest credit is not a client payment.
    const interest = list.find((u) => u.description === "INTEREST")!;
    await m.ignoreIncoming(interest.id);
    const left = await m.listUnmatched();
    assert.ok(!left.some((u) => [garden.id, bath.id, interest.id].includes(u.id)));
  });

  test("AIB credit with an open row is suggested and confirmed", async () => {
    await m.resetClient("Demo Attic Conversions");
    // Fresh import of a single AIB line for Attic (different file, different hash).
    const csv = fixture("bank/aib.csv").replace("05/11/2026", "06/11/2026");
    const r = await m.importBankCsv(csv);
    assert.equal(r.suggested, 1);
    const item = (await m.listUnmatched()).find((u) => u.receivedDate === "2026-11-06" && u.amount === 3690)!;
    const attic = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.equal(item.live[0].paymentId, attic.id);
    await m.assignIncoming(item.id, attic.id);
    const after = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.deepEqual([after.amountCollected, after.method], [3690, "aib"]);
  });
});
