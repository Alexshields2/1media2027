import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { detectFormat, parseAmount, parseBankCsv, parseCsv, parseDate } from "../src/lib/bank-csv";
import { aging, agingBucket, scoreMatch, suggestMatches, SUGGEST_AT, type OpenRow } from "../src/lib/matching";
import { invoiceFacts, verifyStripeEvent } from "../src/lib/stripe-webhook";
import { chaserStage } from "../src/lib/finance";
import { decide } from "../src/lib/guardrails";
import { fixture, stripeFixture } from "./helpers/test-db";

// ---------- CSV ----------

test("csv parser handles quotes, embedded commas/newlines, CRLF and BOM", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x, y", 'say "hi"', "line1\nline2"],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(parseCsv("a;b\n1,5;2"), [["a", "b"], ["1,5", "2"]]);
});

test("amounts and dates in bank formats", () => {
  assert.equal(parseAmount("3,690.00"), 3690);
  assert.equal(parseAmount("€1 234,56"), 1234.56);
  assert.equal(parseAmount("(12.00)"), -12);
  assert.equal(parseAmount("-11.99"), -11.99);
  assert.equal(parseAmount(""), null);
  assert.equal(parseDate("2026-11-06 09:12:45", "iso"), "2026-11-06");
  assert.equal(parseDate("05/11/2026", "dmy"), "2026-11-05");
  assert.equal(parseDate("5 Nov 2026", "dmy"), "2026-11-05");
});

test("format detection from headers", () => {
  assert.equal(detectFormat(parseCsv(fixture("bank/revolut-business.csv"))[0])?.id, "revolut");
  assert.equal(detectFormat(parseCsv(fixture("bank/aib.csv"))[0])?.id, "aib");
  assert.equal(detectFormat(["foo", "bar"]), undefined);
});

test("Revolut Business export: only completed incoming transfers become credits", () => {
  const r = parseBankCsv(fixture("bank/revolut-business.csv"));
  assert.equal(r.format.id, "revolut");
  assert.deepEqual(
    r.credits.map((c) => [c.date, c.amount, c.payer, c.reference]),
    [
      ["2026-11-06", 1107, "AOIFE BYRNE", "Demo Garden Rooms Nov"],
      ["2026-11-07", 406.5, "DEMO BATHROOMS LTD", "1MEDIA OCT"],
      ["2026-11-10", 250, "J SMITH", "deposit"],
    ],
  );
  assert.equal(r.skipped, 3); // card payment, pending, exchange
  assert.equal(r.credits[0].externalId, "revolut:6a3f0c1e-0001-4b2e-9d61-1f0c2a7e0001");
});

test("AIB export: credit column only, DD/MM dates, hashed IDs are stable", () => {
  const r = parseBankCsv(fixture("bank/aib.csv"));
  assert.equal(r.format.id, "aib");
  assert.deepEqual(
    r.credits.map((c) => [c.date, c.amount, c.description]),
    [
      ["2026-11-05", 3690, "DEMO ATTIC CONV SEPA CREDIT 1MEDIA NOV"],
      ["2026-11-07", 0.12, "INTEREST"],
    ],
  );
  assert.equal(r.skipped, 2); // two debits
  assert.equal(parseBankCsv(fixture("bank/aib.csv")).credits[0].externalId, r.credits[0].externalId);
  // An explicit format works too, and a wrong one fails clearly.
  assert.equal(parseBankCsv(fixture("bank/aib.csv"), "aib").credits.length, 2);
  assert.throws(() => parseBankCsv("hello,world\n1,2"), /Couldn't recognise/);
});

test("identical AIB rows on the same day get distinct IDs", () => {
  const head = " Posted Account, Posted Transactions Date, Description1, Debit Amount, Credit Amount\n";
  const row = '"1","01/11/2026","CASH LODGEMENT","","100.00"\n';
  const r = parseBankCsv(head + row + row);
  assert.equal(r.credits.length, 2);
  assert.notEqual(r.credits[0].externalId, r.credits[1].externalId);
});

// ---------- matching ----------

const rows: OpenRow[] = [
  { id: 1, clientId: 10, clientName: "Demo Garden Rooms", contactName: "Aoife", billingMethod: "revolut", period: "2026-11-01", dueDate: "2026-11-01", amountDue: 1107, amountCollected: 0 },
  { id: 2, clientId: 11, clientName: "Demo Bathrooms", contactName: "John", billingMethod: "invoice", period: "2026-10-01", dueDate: "2026-10-01", amountDue: 406.5, amountCollected: 0 },
  { id: 3, clientId: 11, clientName: "Demo Bathrooms", contactName: "John", billingMethod: "invoice", period: "2026-11-01", dueDate: "2026-11-01", amountDue: 406.5, amountCollected: 0 },
  { id: 4, clientId: 12, clientName: "Demo Attic Conversions", contactName: "Mary", billingMethod: "invoice", period: "2026-11-01", dueDate: "2026-11-01", amountDue: 3690, amountCollected: 1000 },
  { id: 5, clientId: 13, clientName: "Far Future Ltd", period: "2027-03-01", dueDate: "2027-03-01", amountDue: 1107, amountCollected: 0 },
];

test("suggests the right row: amount, name in payer/reference, date window, month mention", () => {
  const garden = suggestMatches({ date: "2026-11-06", amount: 1107, payer: "AOIFE BYRNE", reference: "Demo Garden Rooms Nov", channel: "revolut" }, rows);
  assert.equal(garden[0].paymentId, 1);
  assert.ok(garden[0].score >= SUGGEST_AT);
  assert.ok(!garden.some((s) => s.paymentId === 5), "rows due months later are out of the window");

  const bath = suggestMatches({ date: "2026-11-07", amount: 406.5, payer: "DEMO BATHROOMS LTD", reference: "1MEDIA OCT" }, rows);
  assert.equal(bath[0].paymentId, 2, "the reference names October");
  assert.ok(bath[0].reasons.includes("mentions oct"));

  const attic = suggestMatches({ date: "2026-11-08", amount: 2690, payer: "Demo Attic Conversions" }, rows);
  assert.equal(attic[0].paymentId, 4, "matches the remaining balance after a part payment");
  assert.ok(attic[0].reasons.includes("amount matches the balance"));
});

test("weak evidence is not suggested", () => {
  const s = suggestMatches({ date: "2026-11-10", amount: 250, payer: "J SMITH", reference: "deposit" }, rows);
  assert.ok(!s.length || s[0].score < SUGGEST_AT);
  assert.equal(scoreMatch({ date: "2026-11-10", amount: 1107 }, { ...rows[0], amountCollected: 1107 }), null, "paid rows never match");
});

// ---------- aging ----------

test("aging buckets: 0–14, 15–30, 31–60, 60+ and per-client balances", () => {
  assert.equal(agingBucket(-1), null);
  assert.equal(agingBucket(0), "0-14");
  assert.equal(agingBucket(14), "0-14");
  assert.equal(agingBucket(15), "15-30");
  assert.equal(agingBucket(30), "15-30");
  assert.equal(agingBucket(31), "31-60");
  assert.equal(agingBucket(60), "31-60");
  assert.equal(agingBucket(61), "60+");
  const a = aging(
    [
      { clientId: 1, clientName: "A", dueDate: "2026-11-01", owed: 100 }, // 10 days
      { clientId: 1, clientName: "A", dueDate: "2026-10-01", owed: 200 }, // 41 days
      { clientId: 2, clientName: "B", dueDate: "2026-08-01", owed: 50.5 }, // 102 days
      { clientId: 2, clientName: "B", dueDate: "2026-10-20", owed: 25 }, // 22 days
      { clientId: 3, clientName: "C", dueDate: "2026-12-01", owed: 999 }, // not due yet
      { clientId: 4, clientName: "D", dueDate: "2026-10-01", owed: 0 },
    ],
    "2026-11-11",
  );
  assert.deepEqual(a.totals, { "0-14": 100, "15-30": 25, "31-60": 200, "60+": 50.5 });
  assert.equal(a.total, 375.5);
  assert.deepEqual(
    a.clients.map((c) => [c.clientName, c.balance, c.oldestDays]),
    [
      ["A", 300, 41],
      ["B", 75.5, 102],
    ],
  );
});

test("chaser stages", () => {
  assert.equal(chaserStage(2), null);
  assert.equal(chaserStage(3), "3");
  assert.equal(chaserStage(13), "7");
  assert.equal(chaserStage(40), "14");
});

// ---------- Stripe ----------

test("Stripe signature verification accepts signed fixtures and rejects tampering", () => {
  const secret = "whsec_test_secret";
  const body = fixture("stripe/invoice.paid.json");
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  const e = verifyStripeEvent(body, header, secret);
  assert.equal(e.id, "evt_PavingNovPaid");
  assert.throws(() => verifyStripeEvent(body.replace("184500", "999999"), header, secret));
  assert.throws(() => verifyStripeEvent(body, null, secret));
  assert.throws(() => verifyStripeEvent(body, header, "whsec_other"));
});

test("invoice facts: euros, Dublin dates, service month, payment intent", () => {
  const e = stripeFixture<Stripe.Event>("invoice.paid");
  const f = invoiceFacts(e.data.object as Stripe.Invoice, e.created);
  assert.deepEqual(
    { id: f.id, customer: f.customerId, paid: f.amountPaid, due: f.amountDue, date: f.paidDate, period: f.period, pi: f.paymentIntentId },
    { id: "in_DemoPavingNov", customer: "cus_DemoPaving", paid: 1845, due: 1845, date: "2026-11-05", period: "2026-11-01", pi: "pi_DemoPavingNov" },
  );
});

test("guardrails: finance tools are internal, refunds stay blocked", () => {
  assert.equal(decide("OS_QUEUE_CHASER", "L2").action, "run");
  assert.equal(decide("OS_QUEUE_CHASER", "L0").action, "block");
  assert.equal(decide("OS_GET_RECEIVABLES", "L0").action, "run");
  assert.equal(decide("STRIPE_CREATE_REFUND", "L3").action, "block");
});
