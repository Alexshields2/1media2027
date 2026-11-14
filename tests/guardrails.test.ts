import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isRead } from "../src/lib/guardrails";

const cases: [string, "L0" | "L1" | "L2" | "L3", "run" | "propose" | "block"][] = [
  // reads always run
  ["GMAIL_FETCH_EMAILS", "L0", "run"],
  ["OS_LIST_PAYMENTS", "L0", "run"],
  ["METAADS_GET_INSIGHTS", "L0", "run"],
  ["FACEBOOK_GET_PAGE_SETTINGS", "L0", "run"],
  // L0 blocks writes
  ["OS_CREATE_TASK", "L0", "block"],
  // a write whose name contains a read verb is still a write
  ["OS_SAVE_HEALTH_CHECK", "L0", "block"],
  ["X_CREATE_CHECK", "L0", "block"],
  // drafts are safe from L1
  ["GMAIL_CREATE_EMAIL_DRAFT", "L1", "run"],
  // L1 proposes writes
  ["OS_RECORD_PAYMENT", "L1", "propose"],
  // L2: internal writes run, external writes wait
  ["OS_RECORD_PAYMENT", "L2", "run"],
  ["HIGHLEVEL_CREATE_CONTACT", "L2", "run"],
  ["GMAIL_SEND_EMAIL", "L2", "propose"],
  ["STRIPE_CREATE_INVOICE", "L2", "propose"],
  ["SLACK_SEND_MESSAGE", "L2", "propose"],
  // hard blocks at every level
  ["METAADS_UPDATE_CAMPAIGN", "L3", "block"],
  ["STRIPE_CREATE_REFUND", "L3", "block"],
  ["GOOGLEDRIVE_DELETE_FILE", "L3", "block"],
  // L3 runs the rest
  ["GMAIL_SEND_EMAIL", "L3", "run"],
];

for (const [slug, level, expected] of cases) {
  test(`${level} ${slug} -> ${expected}`, () => {
    assert.equal(decide(slug, level).action, expected);
  });
}

test("allow list lets a specific write run at L1", () => {
  assert.equal(decide("OS_SAVE_REPORT", "L1", ["OS_SAVE_REPORT"]).action, "run");
});

test("every OS tool and common Composio slug classifies correctly", () => {
  const reads = [
    "OS_LIST_CLIENTS", "OS_LIST_HEALTH", "OS_LIST_PAYMENTS", "OS_LIST_REPORTS", "OS_LIST_TASKS",
    "GOOGLECALENDAR_EVENTS_LIST", "HIGHLEVEL_SEARCH_CONTACTS", "GMAIL_FETCH_EMAILS",
    "METAADS_GET_INSIGHTS", "FACEBOOK_GET_PAGE_SETTINGS",
  ];
  const writes = [
    "OS_CREATE_TASK", "OS_RECORD_PAYMENT", "OS_SAVE_HEALTH_CHECK", "OS_SAVE_REPORT",
    "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL", "X_CREATE_CHECK",
  ];
  for (const s of reads) assert.equal(isRead(s), true, s);
  for (const s of writes) assert.equal(isRead(s), false, s);
});
