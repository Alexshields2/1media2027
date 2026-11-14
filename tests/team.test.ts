import { test } from "node:test";
import assert from "node:assert/strict";
import { canAssign, canSee, downline, upline, wouldLoop } from "../src/lib/team";

// Alex (owner) -> Jamie (manager) -> Ryan (member); Sam reports to Alex too.
const team = [
  { id: 1, managerId: null, role: "owner" as const },
  { id: 2, managerId: 1, role: "manager" as const },
  { id: 3, managerId: 2, role: "member" as const },
  { id: 4, managerId: 1, role: "member" as const },
];

test("downline follows the reporting line", () => {
  assert.deepEqual(downline(team, 1).sort(), [2, 3, 4]);
  assert.deepEqual(downline(team, 2), [3]);
  assert.deepEqual(downline(team, 3), []);
});

test("upline is nearest manager first", () => {
  assert.deepEqual(upline(team, 3), [2, 1]);
  assert.deepEqual(upline(team, 1), []);
});

test("Alex delegates to anyone, Jamie to Ryan, Ryan to nobody else", () => {
  assert.ok(canAssign(team, 1, 3));
  assert.ok(canAssign(team, 2, 3));
  assert.ok(!canAssign(team, 2, 1), "Jamie can't hand work up to Alex");
  assert.ok(!canAssign(team, 2, 4), "Jamie can't hand work sideways");
  assert.ok(!canAssign(team, 3, 2));
  assert.ok(canAssign(team, 3, 3), "everyone can assign to themselves");
});

test("visibility matches delegation", () => {
  assert.ok(canSee(team, 2, 3));
  assert.ok(!canSee(team, 3, 2));
});

test("a manager change can't create a loop", () => {
  assert.ok(wouldLoop(team, 2, 3), "Jamie can't report to Ryan");
  assert.ok(wouldLoop(team, 2, 2));
  assert.ok(!wouldLoop(team, 3, 1));
  assert.ok(!wouldLoop(team, 1, null));
});

test("a loop already in the data doesn't hang", () => {
  const bad = [
    { id: 1, managerId: 2, role: "member" as const },
    { id: 2, managerId: 1, role: "member" as const },
  ];
  assert.deepEqual(downline(bad, 1), [2]);
  assert.deepEqual(upline(bad, 1), [2]);
});
