import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyStandard } from "../src/lib/weekly-standard";
import { teamPerformance, ratingLabel } from "../src/lib/team-performance";

test("weekly standard: a client with everything done is on standard", () => {
  const r = weeklyStandard({
    clientId: 1,
    report: { status: "sent" },
    health: { status: "green", resolved: false, untouched: "green" },
    overdueTasks: 0,
    overduePayments: 0,
    touchpoints: 2,
  });
  assert.equal(r.total, 7);
  assert.equal(r.done, 7);
  assert.equal(r.onStandard, true);
});

test("weekly standard: missing pieces are counted and explained", () => {
  const r = weeklyStandard({ clientId: 2, report: { status: "draft" }, health: { status: "red", resolved: false, untouched: "red" }, overdueTasks: 2, overduePayments: 1, touchpoints: 0 });
  assert.equal(r.onStandard, false);
  assert.deepEqual(
    r.items.filter((i) => !i.done).map((i) => i.key),
    ["report", "light", "leads", "tasks", "paid", "contact"],
  );
  assert.equal(r.items.find((i) => i.key === "tasks")!.detail, "2 overdue");
});

test("weekly standard: red but resolved passes; money and unknown leads are left out", () => {
  const r = weeklyStandard({ clientId: 3, report: null, health: { status: "red", resolved: true, untouched: "unknown" }, overdueTasks: 0, touchpoints: 1 });
  assert.equal(r.items.find((i) => i.key === "light")!.done, true);
  assert.equal(r.items.some((i) => i.key === "paid" || i.key === "leads"), false);
  assert.equal(r.total, 5);
});

test("team performance: on-time work rates higher than late work and overdue tasks cost points", () => {
  const day = (d: string) => new Date(`${d}T12:00:00Z`);
  const rows = teamPerformance(
    [
      { assignee: "Jamie", status: "done", dueDate: "2026-11-10", completedAt: day("2026-11-09") },
      { assignee: "Jamie", status: "done", dueDate: "2026-11-12", completedAt: day("2026-11-12") },
      { assignee: "Niamh", status: "done", dueDate: "2026-11-05", completedAt: day("2026-11-08") },
      { assignee: "Niamh", status: "done", dueDate: null, completedAt: day("2026-11-01") },
      { assignee: "Niamh", status: "todo", dueDate: "2026-11-10", completedAt: null },
      { assignee: "Old", status: "done", dueDate: null, completedAt: day("2026-08-01") },
      { assignee: null, status: "todo", dueDate: "2026-11-01", completedAt: null },
    ],
    "2026-11-14",
  );
  assert.deepEqual(rows.map((r) => r.name), ["Jamie", "Niamh"]);
  assert.equal(rows[0].score, 100);
  assert.equal(rows[0].label, "Excellent");
  assert.equal(rows[1].onTime, 1);
  assert.equal(rows[1].overdue, 1);
  assert.equal(rows[1].score, 57); // 70*0.5 + 30*1 - 8
  assert.equal(ratingLabel(69), "Needs focus");
});
