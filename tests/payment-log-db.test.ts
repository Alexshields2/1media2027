import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { createTestDb, dropTestDb, skipReason, stripeFixture } from "./helpers/test-db";

// The payment log against a throwaway Postgres database: ticks, unticks, the editor and the audit trail.

describe("payment log (database)", { skip: skipReason }, () => {
  let m: typeof import("./money-loop-db.lib");
  let ownerId: number;

  before(async () => {
    await createTestDb();
    delete process.env.SLACK_WEBHOOK_URL;
    m = await import("./money-loop-db.lib");
    await m.seed();
    ownerId = (await m.addOwner()).id;
  });
  after(dropTestDb);

  test("ticking marks the month paid in full, today, with the client's method, and is audited", async () => {
    const oct = await m.row("Demo Westside", "2026-10-01");
    assert.equal(oct.amountCollected, 0);
    assert.deepEqual(await m.tickPayments([oct.id], ownerId, "2026-11-14"), [oct.id]);
    const after = await m.row("Demo Westside", "2026-10-01");
    assert.deepEqual([after.amountCollected, after.paidDate, after.method], [615, "2026-11-14", "invoice"]);
    const [a] = await m.auditFor(`payment:${oct.id}`);
    assert.equal(a.action, "payment.record");
    assert.equal(a.userId, ownerId);
    assert.deepEqual((a.detail as { after: unknown }).after, { amountCollected: 615, paidDate: "2026-11-14", method: "invoice" });
    // Ticking again is a no-op (no second audit row).
    assert.deepEqual(await m.tickPayments([oct.id], ownerId, "2026-11-14"), []);
    assert.equal((await m.auditFor(`payment:${oct.id}`)).length, 1);
  });

  test("a tick keeps a date and method already on the row", async () => {
    const nov = await m.row("Demo Windows", "2026-11-01");
    await m.editPayment(nov.id, { amountCollected: 200, paidDate: "2026-11-03", method: "revolut", notes: "Part paid" }, ownerId);
    await m.tickPayments([nov.id], ownerId, "2026-11-14");
    const after = await m.row("Demo Windows", "2026-11-01");
    assert.deepEqual([after.amountCollected, after.paidDate, after.method, after.notes], [615, "2026-11-03", "revolut", "Part paid"]);
  });

  test("unticking sets the month back to unpaid and is audited", async () => {
    const oct = await m.row("Demo Westside", "2026-10-01");
    assert.deepEqual(await m.untickPayments([oct.id], ownerId), [oct.id]);
    const after = await m.row("Demo Westside", "2026-10-01");
    assert.deepEqual([after.amountCollected, after.paidDate], [0, null]);
    const audits = await m.auditFor(`payment:${oct.id}`);
    assert.equal(audits.at(-1)!.action, "payment.unrecord");
    assert.equal(audits.at(-1)!.userId, ownerId);
  });

  test("unticking a month a Stripe payment was assigned to puts that payment back to assign", async () => {
    const e = structuredClone(stripeFixture<Stripe.Event>("invoice.paid"));
    await m.handleStripeEvent(e);
    const [inc] = await m.incoming({ stripeInvoiceId: "in_DemoPavingNov" });
    const nov = await m.row("Demo Paving Co", "2026-11-01");
    await m.assignIncomingParts(inc.id, [{ paymentId: nov.id }]);
    assert.equal((await m.incomingById(inc.id)).status, "matched");

    await m.untickPayments([nov.id], ownerId);
    const back = await m.incomingById(inc.id);
    assert.deepEqual([back.status, back.allocated, back.allocations], ["unmatched", 0, []]);
    assert.ok((await m.listUnmatched()).some((u) => u.id === inc.id && u.remaining === 1845));
    const [audit] = (await m.auditFor(`payment:${nov.id}`)).filter((a) => a.action === "payment.unrecord");
    assert.equal((audit.detail as { releasedFromIncoming: number }).releasedFromIncoming, 1845);
  });

  test("the editor records a part payment, and refuses more than is due", async () => {
    const oct = await m.row("Demo Bathrooms", "2026-10-01");
    await m.editPayment(oct.id, { amountCollected: 200, paidDate: null, method: null, notes: "  Paid 200, rest Friday  " }, ownerId);
    const after = await m.row("Demo Bathrooms", "2026-10-01");
    assert.equal(after.amountCollected, 200);
    assert.ok(after.paidDate, "a date is filled in for money received");
    assert.equal(after.notes, "Paid 200, rest Friday");
    assert.equal(m.paymentState(after, "2026-11-14"), "part");
    await assert.rejects(m.editPayment(oct.id, { amountCollected: 999, paidDate: null, method: null, notes: null }, ownerId), /more than/);
    await assert.rejects(m.editPayment(oct.id, { amountCollected: -1, paidDate: null, method: null, notes: null }, ownerId), /negative/);
  });

  test("the log for a year: months, lines and totals from the database", async () => {
    const log = await m.loadPaymentLog(2026, "2026-11-14");
    assert.deepEqual(log.months.slice(-3), ["2026-10-01", "2026-11-01", "2026-12-01"], "December shows: a row exists ahead");
    assert.ok(log.years.includes(2026));
    const paving = log.lines.find((l) => l.client.name === "Demo Paving Co")!;
    assert.equal(paving.cells["2026-10-01"]?.amountCollected, 1845);
    assert.ok(log.summary.unpaidMonths > 0);
  });
});
