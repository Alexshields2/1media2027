import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PER_WINDOW, WINDOW_MS, createLimiter, reportError, shouldAlert, slackText, toReport } from "../src/lib/monitoring";

test("rate limit: same error alerts once per window", () => {
  const l = createLimiter();
  assert.equal(shouldAlert(l, "a", 0), true);
  assert.equal(shouldAlert(l, "a", 1000), false);
  assert.equal(shouldAlert(l, "a", WINDOW_MS + 1), true);
});

test("rate limit: total alerts capped per window", () => {
  const l = createLimiter();
  for (let i = 0; i < MAX_PER_WINDOW; i++) assert.equal(shouldAlert(l, `e${i}`, i), true);
  assert.equal(shouldAlert(l, "another", 100), false);
  assert.equal(shouldAlert(l, "another", WINDOW_MS + 100), true);
});

test("toReport and slackText summarise the error", () => {
  const err = Object.assign(new Error("boom"), { digest: "123" });
  const r = toReport(err, { path: "/payments", method: "GET" }, { routePath: "/payments", routeType: "render" });
  assert.equal(r.message, "boom");
  assert.equal(r.digest, "123");
  const text = slackText(r);
  assert.match(text, /GET \/payments/);
  assert.match(text, /boom/);
  assert.equal(toReport("plain").message, "plain");
});

test("reportError logs JSON and posts to Slack once during a crash loop", async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  const logs: string[] = [];
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response("ok");
  }) as typeof fetch;
  console.error = (s: string) => logs.push(s);
  try {
    for (let i = 0; i < 20; i++) await reportError({ message: "crash loop", path: "/x" });
  } finally {
    globalThis.fetch = origFetch;
    console.error = origErr;
    delete process.env.SLACK_WEBHOOK_URL;
  }
  assert.equal(logs.length, 20);
  assert.equal(JSON.parse(logs[0]).message, "crash loop");
  assert.equal(calls.length, 1);
});
