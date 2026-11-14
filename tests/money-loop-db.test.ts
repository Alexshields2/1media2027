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

  /** A fixture event with fresh event and invoice IDs, so it doesn't collide with the other tests. */
  const fresh = (name: string, tag: string, patch: Partial<Stripe.Invoice> = {}) => {
    const e = structuredClone(ev(name));
    e.id = `evt_${tag}`;
    Object.assign(e.data.object as Stripe.Invoice, { id: `in_${tag}`, ...patch });
    return e;
  };

  test("a Stripe event never changes payment rows: every payment waits for the owner", async () => {
    const before = await m.paymentSnapshot();
    const known = await m.handleStripeEvent(fresh("invoice.paid", "NeverKnown"));
    const unknown = await m.handleStripeEvent(fresh("invoice.paid.unknown-customer", "NeverUnknown"));
    const mystery = await m.handleStripeEvent(fresh("invoice.paid.unmatched", "NeverMystery"));
    const partial = await m.handleStripeEvent(fresh("invoice.updated.partial", "NeverPartial", { customer: "cus_DemoPaving" }));
    for (const r of [known, unknown, mystery, partial]) assert.match(r.outcome, /^to assign/);
    assert.deepEqual(await m.paymentSnapshot(), before, "no payment row was touched");

    const [k] = await m.incoming({ stripeInvoiceId: "in_NeverKnown" });
    assert.deepEqual([k.status, k.allocated, k.allocations, k.matchedBy], ["unmatched", 0, [], null]);
    assert.equal(k.clientId, (await m.client("Demo Paving Co")).id, "the client is known from the Stripe customer");
    // Suggested, not applied: Paving's November is the likely month.
    assert.equal(k.suggestions[0]?.paymentId, (await m.row("Demo Paving Co", "2026-11-01")).id);
    const [u] = await m.incoming({ stripeInvoiceId: "in_NeverUnknown" });
    assert.deepEqual([u.status, u.allocated, u.clientId], ["unmatched", 0, null]);
    assert.match(u.notes ?? "", /No client has Stripe customer cus_NewGarden/);
    await m.deleteIncoming(["in_NeverKnown", "in_NeverUnknown", "in_NeverMystery", "in_NeverPartial"]);
  });

  test("Stripe invoice.paid: recorded once (retries, overlapping events), then the owner ticks the month", async () => {
    const r1 = await m.handleStripeEvent(ev("invoice.paid"));
    assert.match(r1.outcome, /to assign: €1,845 from Demo Paving Co/);
    assert.equal((await m.row("Demo Paving Co", "2026-11-01")).amountCollected, 0, "not applied automatically");

    // Stripe retries the same event.
    const r2 = await m.handleStripeEvent(ev("invoice.paid"));
    assert.equal(r2.duplicate, true);
    // A different event for the same invoice (invoice.payment_succeeded) adds nothing.
    const r3 = await m.handleStripeEvent(ev("invoice.payment_succeeded"));
    assert.match(r3.outcome, /already recorded/);
    const inc = await m.incoming({ stripeInvoiceId: "in_DemoPavingNov" });
    assert.equal(inc.length, 1);

    // The owner says it's for November.
    const nov = await m.row("Demo Paving Co", "2026-11-01");
    await m.assignIncomingParts(inc[0].id, [{ paymentId: nov.id }]);
    const row = await m.row("Demo Paving Co", "2026-11-01");
    assert.deepEqual([row.amountCollected, row.paidDate, row.method, row.stripeInvoiceId], [1845, "2026-11-05", "stripe", "in_DemoPavingNov"]);
    assert.match(row.notes ?? "", /Stripe invoice 1M-0042 of €1,845 paid 2026-11-05 \(Demo Paving Co\), assigned by owner/);
    assert.equal((await m.incomingById(inc[0].id)).status, "matched");
    // October was already paid and stays untouched.
    assert.equal((await m.row("Demo Paving Co", "2026-10-01")).amountCollected, 1845);
  });

  test("concurrent deliveries of the same event record the payment once", async () => {
    const e = { ...ev("invoice.paid.after-partial"), id: "evt_concurrent_test" } as Stripe.Event;
    // Use a fresh invoice so this test doesn't depend on order: same payload, new invoice ID.
    (e.data.object as Stripe.Invoice).id = "in_ConcurrentAttic";
    (e.data.object as Stripe.Invoice).customer = "cus_Concurrent";
    await m.setStripeCustomer("Demo Bathrooms", "cus_Concurrent");
    const before = await m.paymentSnapshot();
    const results = await Promise.all([m.handleStripeEvent(e), m.handleStripeEvent(e), m.handleStripeEvent(e)]);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    const inc = await m.incoming({ stripeInvoiceId: "in_ConcurrentAttic" });
    assert.equal(inc.length, 1);
    assert.deepEqual([inc[0].amount, inc[0].allocated, inc[0].status], [3690, 0, "unmatched"]);
    assert.equal(inc[0].clientId, (await m.client("Demo Bathrooms")).id);
    assert.deepEqual(await m.paymentSnapshot(), before);
    await m.resetClient("Demo Bathrooms");
  });

  test("partial payment then full payment: each recorded once, the owner puts both on the month", async () => {
    await m.setStripeCustomer("Demo Attic Conversions", "cus_DemoAttic");
    const p = await m.handleStripeEvent(ev("invoice.updated.partial"));
    assert.match(p.outcome, /€1,000/);
    await m.handleStripeEvent(ev("invoice.paid.after-partial"));
    assert.equal((await m.row("Demo Attic Conversions", "2026-11-01")).amountCollected, 0);
    const inc = (await m.incoming({ stripeInvoiceId: "in_DemoAtticNov" })).sort((a, b) => a.amount - b.amount);
    assert.deepEqual(inc.map((i) => i.amount), [1000, 2690]);

    const nov = await m.row("Demo Attic Conversions", "2026-11-01");
    await m.assignIncomingParts(inc[0].id, [{ paymentId: nov.id }]);
    let row = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.equal(row.amountCollected, 1000);
    assert.equal(m.paymentState(row, "2026-11-11"), "part");
    await m.assignIncomingParts(inc[1].id, [{ paymentId: nov.id }]);
    row = await m.row("Demo Attic Conversions", "2026-11-01");
    assert.deepEqual([row.amountCollected, row.paidDate], [3690, "2026-11-08"]);
  });

  test("unknown customer: suggested by amount and month, never applied; the owner assigns and links it", async () => {
    const r = await m.handleStripeEvent(ev("invoice.paid.unknown-customer"));
    assert.match(r.outcome, /^to assign/);
    const garden = await m.row("Demo Garden Rooms", "2026-11-01");
    assert.equal(garden.amountCollected, 0);
    const item = (await m.listUnmatched()).find((u) => u.stripeInvoiceId === "in_NewGardenNov")!;
    assert.equal(item.live[0].paymentId, garden.id);
    assert.ok(item.live[0].score >= m.SUGGEST_AT);
    await m.assignIncomingParts(item.id, [{ paymentId: garden.id }], { linkStripeCustomer: true });
    assert.equal((await m.row("Demo Garden Rooms", "2026-11-01")).amountCollected, 1107);
    assert.equal((await m.client("Demo Garden Rooms")).stripeCustomerId, "cus_NewGarden");
  });

  test("no match lands in Unmatched; one-click assignment applies it and links the customer", async () => {
    const r = await m.handleStripeEvent(ev("invoice.paid.unmatched"));
    assert.match(r.outcome, /to assign/);
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

  test("assigning a Stripe payment to a chosen month ticks that month (paid ahead)", async () => {
    // Paving pays again in November: it's for December, which only the owner knows.
    const r = await m.handleStripeEvent(fresh("invoice.paid", "PavingAhead"));
    assert.match(r.outcome, /^to assign/);
    const [inc] = await m.incoming({ stripeInvoiceId: "in_PavingAhead" });
    const dec = await m.row("Demo Paving Co", "2026-12-01");
    assert.equal(dec.amountCollected, 0);
    await m.assignIncomingParts(inc.id, [{ paymentId: dec.id }]);
    const after = await m.row("Demo Paving Co", "2026-12-01");
    assert.deepEqual([after.amountCollected, after.paidDate, after.method], [1845, "2026-11-05", "stripe"]);
    assert.equal(m.paymentState(after, "2026-11-11"), "paid");
    assert.equal((await m.row("Demo Paving Co", "2026-11-01")).amountCollected, 1845, "November untouched");
    const done = await m.incomingById(inc.id);
    assert.deepEqual([done.status, done.matchedBy, done.allocations], ["matched", "owner", [{ paymentId: dec.id, amount: 1845 }]]);
  });

  test("a Stripe payment split across two months ticks both", async () => {
    // Demo Windows (€615 a month) pays October and November late, in one go.
    const r = await m.handleStripeEvent(fresh("invoice.paid.unmatched", "WindowsTwoMonths", { customer: "cus_DemoWindows", customer_name: "Demo Windows", amount_paid: 123000, amount_due: 123000 }));
    assert.match(r.outcome, /^to assign: €1,230/);
    const [inc] = await m.incoming({ stripeInvoiceId: "in_WindowsTwoMonths" });
    const oct = await m.row("Demo Windows", "2026-10-01");
    const nov = await m.row("Demo Windows", "2026-11-01");

    // Asking for more than a month owes fails and changes nothing.
    await assert.rejects(m.assignIncomingParts(inc.id, [{ paymentId: oct.id, amount: 1000 }, { paymentId: nov.id, amount: 230 }]), /only owes €615/);
    assert.equal((await m.row("Demo Windows", "2026-10-01")).amountCollected, 0);
    await assert.rejects(m.assignIncomingParts(inc.id, [{ paymentId: oct.id, amount: 615 }, { paymentId: nov.id, amount: 700 }]), /only €1,230 of this payment is left/);

    await m.assignIncomingParts(inc.id, [{ paymentId: oct.id, amount: 615 }, { paymentId: nov.id, amount: 615 }], { linkStripeCustomer: true });
    for (const month of ["2026-10-01", "2026-11-01"]) {
      const row = await m.row("Demo Windows", month);
      assert.deepEqual([row.amountCollected, row.paidDate, row.method], [615, "2026-11-07", "stripe"], month);
    }
    const done = await m.incomingById(inc.id);
    assert.equal(done.status, "matched");
    assert.equal(done.allocations.length, 2);
    assert.equal((await m.client("Demo Windows")).stripeCustomerId, "cus_DemoWindows");
  });

  test("assigning to a month with no row yet creates it from the retainer", async () => {
    const r = await m.handleStripeEvent(fresh("invoice.paid.unmatched", "WindowsDec", { customer: "cus_DemoWindows" }));
    assert.match(r.outcome, /Demo Windows/);
    const [inc] = await m.incoming({ stripeInvoiceId: "in_WindowsDec" });
    const windows = await m.client("Demo Windows");
    await m.assignIncomingParts(inc.id, [{ clientId: windows.id, period: "2026-12-01" }]);
    const dec = await m.row("Demo Windows", "2026-12-01");
    assert.deepEqual([dec.label, dec.amountDue, dec.amountCollected, dec.dueDate], ["Retainer", 615, 615, "2026-12-01"]);
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
