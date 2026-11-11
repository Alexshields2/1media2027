import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hashPassword, passwordProblem, verifyPassword } from "../src/lib/password";
import { newSessionId, signValue, verifySigned, authSecret } from "../src/lib/session-token";
import { bootstrapMode, isRateLimited, isSessionUsable, nameFromEmail, normalizeEmail, RATE_LIMIT } from "../src/lib/auth-rules";
import { can, canDecide, canRunAgent, isFinanceAction } from "../src/lib/roles";
import { databaseUrl } from "../src/db/url";
import { integrationStatus } from "../src/lib/integrations";

// ---------- password hashing ----------

test("hashPassword produces a salted scrypt hash that verifies", async () => {
  const h1 = await hashPassword("correct horse battery");
  const h2 = await hashPassword("correct horse battery");
  assert.match(h1, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(h1, h2, "each hash has its own salt");
  assert.equal(await verifyPassword("correct horse battery", h1), true);
  assert.equal(await verifyPassword("correct horse battery", h2), true);
});

test("verifyPassword rejects wrong passwords and junk hashes", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("", h), false);
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "plain-text"), false);
  assert.equal(await verifyPassword("x", "scrypt$abc$8$1$AAAA$AAAA"), false);
  assert.equal(await verifyPassword("x", "bcrypt$1$2$3$4$5"), false);
});

test("passwordProblem enforces a minimum length", () => {
  assert.ok(passwordProblem("short"));
  assert.equal(passwordProblem("long enough pw"), null);
});

// ---------- session cookie signing ----------

test("signed session values verify only with the same secret and untampered", async () => {
  const id = newSessionId();
  assert.match(id, /^[\w-]{43}$/);
  assert.notEqual(newSessionId(), id);
  const signed = await signValue(id, "secret-a");
  assert.equal(await verifySigned(signed, "secret-a"), id);
  assert.equal(await verifySigned(signed, "secret-b"), null, "other secret");
  assert.equal(await verifySigned(signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A"), "secret-a"), null, "tampered signature");
  assert.equal(await verifySigned("x" + signed, "secret-a"), null, "tampered id");
  assert.equal(await verifySigned(id, "secret-a"), null, "unsigned");
  assert.equal(await verifySigned(undefined, "secret-a"), null);
  assert.equal(await verifySigned(signed, null), null, "no secret configured");
});

test("authSecret prefers AUTH_SECRET and never uses the production DB url on previews", () => {
  assert.equal(authSecret({ AUTH_SECRET: "s", DATABASE_URL: "db" }), "s");
  assert.equal(authSecret({ DATABASE_URL: "db" }), "db");
  assert.equal(authSecret({ VERCEL_ENV: "preview", DATABASE_URL: "prod" }), null);
  assert.equal(authSecret({}), null);
});

// ---------- session validation ----------

test("isSessionUsable checks expiry, revocation and active user", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const later = new Date("2026-12-01T00:00:00Z");
  const earlier = new Date("2026-11-01T00:00:00Z");
  assert.equal(isSessionUsable({ expiresAt: later, revokedAt: null }, { active: true }, now), true);
  assert.equal(isSessionUsable({ expiresAt: earlier, revokedAt: null }, { active: true }, now), false, "expired");
  assert.equal(isSessionUsable({ expiresAt: now, revokedAt: null }, { active: true }, now), false, "expires now");
  assert.equal(isSessionUsable({ expiresAt: later, revokedAt: earlier }, { active: true }, now), false, "revoked");
  assert.equal(isSessionUsable({ expiresAt: later, revokedAt: null }, { active: false }, now), false, "deactivated user");
  assert.equal(isSessionUsable(null, { active: true }, now), false);
  assert.equal(isSessionUsable({ expiresAt: later, revokedAt: null }, null, now), false);
});

test("rate limiting kicks in per email and per IP", () => {
  assert.equal(isRateLimited({ email: 0, ip: 0 }), false);
  assert.equal(isRateLimited({ email: RATE_LIMIT.perEmail - 1, ip: 0 }), false);
  assert.equal(isRateLimited({ email: RATE_LIMIT.perEmail, ip: 0 }), true);
  assert.equal(isRateLimited({ email: 0, ip: RATE_LIMIT.perIp }), true);
});

test("bootstrap: ADMIN_PASSWORD only works while there are no users", () => {
  assert.equal(bootstrapMode({ userCount: 0, adminPassword: "pw", ownerEmail: "alex@1media.ie" }), "owner_from_env");
  assert.equal(bootstrapMode({ userCount: 0, adminPassword: "pw" }), "setup");
  assert.equal(bootstrapMode({ userCount: 0, adminPassword: "pw", ownerEmail: "not an email" }), "setup");
  assert.equal(bootstrapMode({ userCount: 0 }), "closed");
  assert.equal(bootstrapMode({ userCount: 1, adminPassword: "pw", ownerEmail: "alex@1media.ie" }), "accounts");
});

test("emails are normalised and names derived", () => {
  assert.equal(normalizeEmail("  Jamie@1Media.IE "), "jamie@1media.ie");
  assert.equal(nameFromEmail("jamie.smith@1media.ie"), "Jamie Smith");
});

// ---------- roles ----------

test("owners can do everything; team members can't touch money", () => {
  for (const p of ["payments", "money_stats", "client_billing", "approve_finance", "run_finance_agent", "manage_users", "view_audit"] as const) {
    assert.equal(can("owner", p), true, `owner ${p}`);
    assert.equal(can("team", p), false, `team ${p}`);
    assert.equal(can(null, p), false, `signed out ${p}`);
  }
});

test("finance actions are recognised", () => {
  assert.equal(isFinanceAction("finance", "GMAIL_SEND_EMAIL"), true, "anything the finance agent wants");
  assert.equal(isFinanceAction("inbox", "STRIPE_CREATE_INVOICE"), true);
  assert.equal(isFinanceAction("jarvis", "OS_RECORD_PAYMENT"), true);
  assert.equal(isFinanceAction("sales", "QUICKBOOKS_CREATE_INVOICE"), true);
  assert.equal(isFinanceAction("inbox", "GMAIL_SEND_EMAIL"), false);
  assert.equal(isFinanceAction("weekly-report", "SLACK_SEND_MESSAGE"), false);
  assert.equal(isFinanceAction("client-health", "OS_CREATE_TASK"), false);
});

test("team can approve ordinary actions but not finance or Stripe ones", () => {
  assert.equal(canDecide("team", "inbox", "GMAIL_SEND_EMAIL"), true);
  assert.equal(canDecide("team", "finance", "GMAIL_SEND_EMAIL"), false);
  assert.equal(canDecide("team", "inbox", "STRIPE_CREATE_INVOICE"), false);
  assert.equal(canDecide("owner", "finance", "STRIPE_CREATE_INVOICE"), true);
  assert.equal(canDecide(null, "inbox", "GMAIL_SEND_EMAIL"), false);
});

test("team can't run the finance agent", () => {
  assert.equal(canRunAgent("team", "finance"), false);
  assert.equal(canRunAgent("team", "jarvis"), true);
  assert.equal(canRunAgent("owner", "finance"), true);
  assert.equal(canRunAgent(undefined, "jarvis"), false);
});

// ---------- preview safety ----------

test("previews only ever use PREVIEW_DATABASE_URL", () => {
  assert.equal(databaseUrl({ DATABASE_URL: "prod" }), "prod");
  assert.equal(databaseUrl({ POSTGRES_URL: "pg" }), "pg");
  assert.equal(databaseUrl({ VERCEL_ENV: "production", DATABASE_URL: "prod" }), "prod");
  assert.equal(databaseUrl({ VERCEL_ENV: "preview", DATABASE_URL: "prod", POSTGRES_URL: "prod" }), undefined);
  assert.equal(databaseUrl({ VERCEL_ENV: "preview", DATABASE_URL: "prod", PREVIEW_DATABASE_URL: "pre" }), "pre");
});

test("migrate.mjs refuses to touch DATABASE_URL on a preview build", () => {
  const r = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    env: { PATH: process.env.PATH, VERCEL_ENV: "preview", DATABASE_URL: "postgres://prod.invalid:5432/never", NODE_ENV: "test" } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /REFUSING to migrate on a preview build/);
});

// ---------- settings ----------

test("integration status says yes/no and never leaks values", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-secret", STRIPE_SECRET_KEY: "sk_live_secret" };
  const s = integrationStatus(env);
  assert.deepEqual(
    s.map((i) => [i.name, i.configured]),
    [["Anthropic", true], ["Composio", false], ["Stripe", false], ["Slack", false], ["Notion", false]],
  );
  assert.deepEqual(s.find((i) => i.name === "Stripe")?.needs, ["STRIPE_WEBHOOK_SECRET"]);
  assert.ok(!JSON.stringify(s).includes("sk-ant-secret") && !JSON.stringify(s).includes("sk_live_secret"));
});
