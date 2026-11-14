import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, isDue, isoWeekday, parseSteps, videoEmbedUrl } from "../src/lib/sops";
import { signSession, verifySession } from "../src/lib/auth";
import { decide } from "../src/lib/guardrails";

const base = { agentEnabled: true, archived: false, schedule: "manual" as const, weekday: null, monthDay: null, lastRunDate: null };

test("isoWeekday", () => {
  assert.equal(isoWeekday("2026-11-16"), 1); // Monday
  assert.equal(isoWeekday("2026-11-15"), 7); // Sunday
});

test("SOP schedules", () => {
  assert.ok(!isDue({ ...base }, "2026-11-16"), "manual never runs on its own");
  assert.ok(isDue({ ...base, schedule: "daily" }, "2026-11-15"));
  assert.ok(isDue({ ...base, schedule: "weekdays" }, "2026-11-16"));
  assert.ok(!isDue({ ...base, schedule: "weekdays" }, "2026-11-15"));
  assert.ok(isDue({ ...base, schedule: "weekly", weekday: 1 }, "2026-11-16"));
  assert.ok(!isDue({ ...base, schedule: "weekly", weekday: 1 }, "2026-11-17"));
  assert.ok(isDue({ ...base, schedule: "monthly", monthDay: 1 }, "2026-12-01"));
  assert.ok(!isDue({ ...base, schedule: "monthly", monthDay: 1 }, "2026-12-02"));
  assert.ok(!isDue({ ...base, schedule: "daily", lastRunDate: "2026-11-15" }, "2026-11-15"), "once a day");
  assert.ok(!isDue({ ...base, schedule: "daily", agentEnabled: false }, "2026-11-15"));
  assert.ok(!isDue({ ...base, schedule: "daily", archived: true }, "2026-11-15"));
});

test("describeSchedule", () => {
  assert.equal(describeSchedule({ agentEnabled: true, schedule: "weekly", weekday: 1, monthDay: null, perClient: true }), "Agent: every Monday, for each active client");
  assert.equal(describeSchedule({ agentEnabled: true, schedule: "monthly", weekday: null, monthDay: 1, perClient: false }), "Agent: monthly on the 1st");
  assert.equal(describeSchedule({ agentEnabled: false, schedule: "daily", weekday: null, monthDay: null, perClient: false }), "Manual (people only)");
});

test("video links become embeds", () => {
  assert.equal(videoEmbedUrl("https://www.loom.com/share/abc123def?sid=x"), "https://www.loom.com/embed/abc123def");
  assert.equal(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(videoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(videoEmbedUrl("https://vimeo.com/12345"), "https://player.vimeo.com/video/12345");
  assert.equal(videoEmbedUrl("https://evil.example/share/abc"), null);
  assert.equal(videoEmbedUrl("not a url"), null);
});

test("checklist parsing strips bullets and numbers", () => {
  assert.deepEqual(parseSteps("1. Read record\n- Pull numbers\n\n* [ ] Draft\n  3) Send"), ["Read record", "Pull numbers", "Draft", "Send"]);
});

test("session cookies: valid, tampered, expired", async () => {
  process.env.AUTH_SECRET = "test-secret";
  const now = Date.now();
  const token = (await signSession(7, now))!;
  assert.equal(await verifySession(token, now), 7);
  assert.equal(await verifySession(token.replace(/^7\./, "1."), now), null, "changing the user id breaks the signature");
  assert.equal(await verifySession(token, now + 31 * 86_400_000), null, "expires after 30 days");
  assert.equal(await verifySession("garbage", now), null);
  assert.equal(await verifySession(undefined, now), null);
});

test("new OS tools classify correctly", () => {
  for (const t of ["OS_LIST_TEAM", "OS_LIST_EOD_REPORTS", "OS_LIST_ACTIVITY", "OS_LIST_APPROVALS"]) assert.equal(decide(t, "L0").action, "run", t);
  assert.equal(decide("OS_SAVE_BRIEFING", "L0").action, "block");
  assert.equal(decide("OS_SAVE_BRIEFING", "L2").action, "run");
});
