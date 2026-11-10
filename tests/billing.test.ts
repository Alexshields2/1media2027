import { test } from "node:test";
import assert from "node:assert/strict";
import { amountDue, paymentState } from "../src/lib/billing";
import { addMonths, monthStart, weekStart, daysBetween } from "../src/lib/dates";

test("VAT: plus adds 23%, inc and none don't", () => {
  assert.equal(amountDue({ retainerExVat: 3000, vat: "plus" }), 3690);
  assert.equal(amountDue({ retainerExVat: 750, vat: "plus" }), 922.5);
  assert.equal(amountDue({ retainerExVat: 500, vat: "inc" }), 500);
  assert.equal(amountDue({ retainerExVat: 1500, vat: "none" }), 1500);
});

test("payment states", () => {
  const p = { amountDue: 100, dueDate: "2026-11-01" };
  assert.equal(paymentState({ ...p, amountCollected: 100 }, "2026-11-10"), "paid");
  assert.equal(paymentState({ ...p, amountCollected: 50 }, "2026-11-10"), "part");
  assert.equal(paymentState({ ...p, amountCollected: 0 }, "2026-11-10"), "overdue");
  assert.equal(paymentState({ ...p, amountCollected: 0 }, "2026-11-01"), "due");
  assert.equal(paymentState({ ...p, amountCollected: 0 }, "2026-10-20"), "upcoming");
});

test("dates", () => {
  assert.equal(monthStart("2026-11-10"), "2026-11-01");
  assert.equal(addMonths("2026-12-01", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-01", -1), "2025-12-01");
  assert.equal(weekStart("2026-11-10"), "2026-11-09"); // Tuesday -> Monday
  assert.equal(weekStart("2026-11-15"), "2026-11-09"); // Sunday -> Monday
  assert.equal(daysBetween("2026-11-01", "2026-11-10"), 9);
});
