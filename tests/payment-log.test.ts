import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaymentLog, byMonth, cellState, isOverdue, logMonths, tickedValues, type LogClient, type LogRow } from "../src/lib/payment-log-core";

// The payment log grid, without a database.

const c = (id: number, name: string, status: LogClient["status"] = "active", billingMethod: LogClient["billingMethod"] = "invoice"): LogClient => ({ id, name, status, billingMethod, retainerExVat: 1000 });
let nextId = 1;
const r = (clientId: number, period: string, amountDue: number, amountCollected = 0, extra: Partial<LogRow> = {}): LogRow => ({
  id: nextId++,
  clientId,
  label: "Retainer",
  period,
  amountDue,
  amountCollected,
  dueDate: period,
  paidDate: amountCollected ? period : null,
  method: null,
  notes: null,
  ...extra,
});

test("cell state: paid, part, unpaid, nothing due", () => {
  assert.equal(cellState(r(1, "2026-01-01", 100, 100)), "paid");
  assert.equal(cellState(r(1, "2026-01-01", 100, 99.996)), "paid");
  assert.equal(cellState(r(1, "2026-01-01", 100, 40)), "part");
  assert.equal(cellState(r(1, "2026-01-01", 100, 0)), "unpaid");
  assert.equal(cellState(undefined), "none");
  assert.equal(cellState(r(1, "2026-01-01", 0, 0)), "none");
});

test("overdue: unpaid or part paid, and the due date has passed", () => {
  assert.equal(isOverdue(r(1, "2026-11-01", 100), "2026-11-14"), true);
  assert.equal(isOverdue(r(1, "2026-11-01", 100, 50), "2026-11-14"), true);
  assert.equal(isOverdue(r(1, "2026-11-01", 100, 100), "2026-11-14"), false);
  assert.equal(isOverdue(r(1, "2026-12-01", 100), "2026-11-14"), false);
  assert.equal(isOverdue(r(1, "2026-11-14", 100), "2026-11-14"), false, "due today is not overdue yet");
});

test("a tick pays in full, keeps an existing date and method, else today and the client's method", () => {
  assert.deepEqual(tickedValues({ amountDue: 1845, paidDate: null, method: null }, { billingMethod: "stripe" }, "2026-11-14"), { amountCollected: 1845, paidDate: "2026-11-14", method: "stripe" });
  assert.deepEqual(tickedValues({ amountDue: 1845, paidDate: "2026-11-02", method: "revolut" }, { billingMethod: "stripe" }, "2026-11-14"), { amountCollected: 1845, paidDate: "2026-11-02", method: "revolut" });
});

test("months: Jan to this month this year (extending when a row is ahead), all twelve for past years", () => {
  assert.equal(logMonths(2026, "2026-11-14", []).length, 11);
  assert.equal(logMonths(2026, "2026-11-14", [])[10], "2026-11-01");
  assert.equal(logMonths(2026, "2026-11-14", [{ period: "2026-12-01" }]).length, 12, "a month paid ahead shows up");
  assert.equal(logMonths(2025, "2026-11-14", []).length, 12);
  assert.equal(logMonths(2027, "2026-11-14", []).length, 0);
  assert.equal(logMonths(2026, "2026-01-03", []).length, 1);
});

test("grid: active clients first, paused below; two lines a month get two rows; totals per row, month and year", () => {
  const clients = [c(1, "Zeta Roofing"), c(2, "Alpha Attics", "paused"), c(3, "Deluxe Rooms"), c(4, "New Client", "active")];
  const rows = [
    r(1, "2026-01-01", 1000, 1000),
    r(1, "2026-02-01", 1000, 400),
    r(1, "2026-03-01", 1000, 0),
    r(2, "2026-01-01", 500, 500),
    r(3, "2026-02-01", 2000, 2000),
    r(3, "2026-02-01", 100, 0, { label: "Una AI" }),
    r(3, "2026-03-01", 100, 100, { label: "Una AI" }),
    r(1, "2025-12-01", 1000, 0), // other year: not in this grid
  ];
  const log = buildPaymentLog(clients, rows, 2026, "2026-03-14");
  assert.deepEqual(log.months, ["2026-01-01", "2026-02-01", "2026-03-01"]);
  assert.deepEqual(
    log.lines.map((l) => [l.client.name, l.label, l.first, l.group]),
    [
      ["Deluxe Rooms", "Retainer", true, "active"],
      ["Deluxe Rooms", "Una AI", false, "active"],
      ["New Client", "Retainer", true, "active"], // active, no rows yet: shown with dashes
      ["Zeta Roofing", "Retainer", true, "active"],
      ["Alpha Attics", "Retainer", true, "paused"],
    ],
  );
  const zeta = log.lines.find((l) => l.client.id === 1)!;
  assert.deepEqual([zeta.paid, zeta.due], [1400, 3000]);
  assert.equal(log.lines.find((l) => l.client.id === 4)!.cells["2026-01-01"], undefined);
  assert.deepEqual(log.columns.map((x) => [x.collected, x.due]), [[1500, 1500], [2400, 3100], [100, 1100]]);
  // Outstanding: Zeta Feb 600 + Mar 1000 (due 1 Mar), Deluxe Una AI Feb 100.
  assert.deepEqual(log.summary, { collected: 4000, due: 5700, outstanding: 1700, unpaidMonths: 3 });

  const groups = byMonth(log);
  assert.deepEqual(groups.map((g) => g.period), ["2026-03-01", "2026-02-01", "2026-01-01"], "newest month first");
  assert.deepEqual(groups[1].items.map((i) => `${i.client.name} ${i.row.label}`), ["Deluxe Rooms Retainer", "Deluxe Rooms Una AI", "Zeta Roofing Retainer"]);
});

test("past years only show clients with rows that year", () => {
  const log = buildPaymentLog([c(1, "Old"), c(2, "New")], [r(1, "2025-06-01", 100, 100)], 2025, "2026-11-14");
  assert.deepEqual(log.lines.map((l) => l.client.name), ["Old"]);
  assert.equal(log.months.length, 12);
});

test("the grid never starts before the first month with real payment data", () => {
  assert.deepEqual(logMonths(2026, "2026-03-14", [], "2026-02-01"), ["2026-02-01", "2026-03-01"]);
  assert.deepEqual(logMonths(2025, "2026-11-14", [{ period: "2025-03-01" }], "2026-01-01"), [], "no months before tracking started");
  // Rows generated by mistake for months before tracking started are left out of the grid and the totals.
  const log = buildPaymentLog([c(1, "Zeta")], [r(1, "2025-06-01", 100), r(1, "2026-01-01", 100, 100)], 2025, "2026-11-14", [2026], "2026-01-01");
  assert.deepEqual([log.months, log.lines.length, log.summary.unpaidMonths], [[], 0, 0]);
});
