import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify, X509Certificate } from "node:crypto";
import { parseBankCsv } from "../src/lib/bank-csv";
import { builtInCategory, expensesCsv, merchantKey } from "../src/lib/expense-rules";
import { decryptSecret, encryptSecret } from "../src/lib/secrets";
import { clientAssertion, generateRsaKeyPair, issuerFor, selfSignedCertificate } from "../src/lib/revolut/crypto";
import { consentUrl, exchangeCode, redirectUriFor, refreshAccessToken, RevolutApiError, RevolutAuthError, revolutUrls, type RevolutTransaction } from "../src/lib/revolut/api";
import { mapTransaction } from "../src/lib/revolut/sync";
import { fixture } from "./helpers/test-db";

// Unit tests for expenses and the Revolut Business connection. No database, no network:
// every HTTP call goes to a mocked fetch.

const keys = generateRsaKeyPair();

// ---------- CSV debits ----------

test("Revolut statement CSV: money out becomes expenses; pending, exchanges and money in don't", () => {
  const r = parseBankCsv(fixture("bank/revolut-expenses.csv"));
  assert.equal(r.format.id, "revolut");
  const by = new Map(r.debits.map((d) => [d.externalId, d]));
  assert.deepEqual(
    r.debits.map((d) => [d.counterparty, d.amount]),
    [
      ["Canva", 11.99],
      ["FACEBK *8XK2PL3QZ", 850],
      ["Niamh Designs", 600],
      ["EUR Savings", 2000],
      ["Adobe", 50.12],
      ["Revolut", 0.62],
      ["Grow plan fee", 25],
      ["The Hungry Monk", 64.5],
    ],
  );
  const canva = by.get("revolut:7b000000-0001-4000-8000-000000000001")!;
  assert.equal(canva.date, "2026-10-02");
  assert.equal(canva.cardLast4, "1234");
  assert.equal(canva.mcc, "5734");
  assert.equal(canva.type, "CARD_PAYMENT");
  assert.equal(by.get("revolut:7b000000-0003-4000-8000-000000000003")!.reference, "Oct creatives");
  assert.equal(by.get("revolut:7b000000-0003-4000-8000-000000000003")!.ownTransfer, false);
  assert.equal(by.get("revolut:7b000000-0004-4000-8000-000000000004")!.ownTransfer, true);
  // The card payment's fee is its own expense, keyed off the transaction ID.
  const fee = by.get("revolut:7b000000-0005-4000-8000-000000000005:fee")!;
  assert.equal(fee.type, "FEE");
  assert.equal(fee.description, "Fee on Adobe");
  // Money in is still read as credits for Payments, unchanged.
  assert.deepEqual(
    r.credits.map((c) => [c.payer, c.amount]),
    [
      [null, 2000],
      ["DEMO PAVING CO", 1845],
    ],
  );
});

test("the original Revolut and AIB fixtures: credits unchanged, debits now read", () => {
  const rev = parseBankCsv(fixture("bank/revolut-business.csv"));
  assert.deepEqual(rev.debits.map((d) => [d.counterparty, d.amount]), [["Canva", 11.99]]);
  const aib = parseBankCsv(fixture("bank/aib.csv"));
  assert.ok(aib.debits.some((d) => d.counterparty.startsWith("VODAFONE IRELAND") && d.amount === 45 && d.date === "2026-11-04"));
  assert.ok(aib.debits.some((d) => d.counterparty.startsWith("ESB NETWORKS") && d.amount === 120.4));
  assert.ok(aib.debits.every((d) => /^aib:[0-9a-f]{24}:\d+$/.test(d.externalId)));
  // Same file twice -> same IDs (dedupe key is stable).
  assert.deepEqual(parseBankCsv(fixture("bank/aib.csv")).debits.map((d) => d.externalId), aib.debits.map((d) => d.externalId));
});

// ---------- categories ----------

test("merchantKey strips reference codes, punctuation and company suffixes", () => {
  assert.equal(merchantKey("FACEBK *8XK2PL3QZ"), "facebk");
  assert.equal(merchantKey("FACEBK *ZZ91AB7Q"), "facebk");
  assert.equal(merchantKey("Canva Pty Ltd"), "canva pty");
  assert.equal(merchantKey("Google *GSuite_1media"), "google gsuite media");
});

test("built-in rules: own transfers, fees, ads, software, MCC fallbacks, unknown left empty", () => {
  assert.equal(builtInCategory({ merchant: "EUR Savings", ownTransfer: true }), "transfers");
  assert.equal(builtInCategory({ merchant: "Grow plan fee", type: "FEE" }), "bank_fees");
  assert.equal(builtInCategory({ merchant: "FACEBK *8XK2PL3QZ" }), "advertising");
  assert.equal(builtInCategory({ merchant: "Google Ads" }), "advertising");
  assert.equal(builtInCategory({ merchant: "Google *GSuite_1media" }), "software");
  assert.equal(builtInCategory({ merchant: "Revenue Commissioners" }), "tax");
  assert.equal(builtInCategory({ merchant: "Some Bistro", mcc: "5812" }), "meals");
  assert.equal(builtInCategory({ merchant: "Unknown Air", mcc: "3246" }), "travel");
  assert.equal(builtInCategory({ merchant: "Niamh Designs", type: "TRANSFER" }), null);
});

test("accountant CSV: escapes quotes and commas, defuses formulas, marks transfers as excluded", () => {
  const base = { description: null, currency: "EUR", amountEur: null, vatAmount: null, client: null, source: "csv", cardLast4: null, receiptUrl: null, notes: null, externalId: "x" };
  const csv = expensesCsv([
    { ...base, date: "2026-10-02", merchant: 'Acme, "Ltd"', amount: 10, category: "software" },
    { ...base, date: "2026-10-03", merchant: "=HYPERLINK(1)", amount: 5, category: "transfers" },
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-10-02,"Acme, ""Ltd""",,10\.00,EUR,10\.00,Software & subscriptions,/);
  assert.match(lines[2], /"'=HYPERLINK\(1\)"/);
  assert.match(lines[2], /,no$/);
});

// ---------- secrets ----------

test("secrets: AES-GCM round trip; wrong name, wrong AUTH_SECRET or tampering fail", () => {
  const stored = encryptSecret("refresh-token-value", "revolut.refresh_token", "auth-secret-1");
  assert.match(stored, /^v1:/);
  assert.ok(!stored.includes("refresh-token-value"));
  assert.notEqual(stored, encryptSecret("refresh-token-value", "revolut.refresh_token", "auth-secret-1"), "fresh IV each time");
  assert.equal(decryptSecret(stored, "revolut.refresh_token", "auth-secret-1"), "refresh-token-value");
  assert.throws(() => decryptSecret(stored, "revolut.access_token", "auth-secret-1"));
  assert.throws(() => decryptSecret(stored, "revolut.refresh_token", "auth-secret-2"));
  const buf = Buffer.from(stored.slice(3), "base64");
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decryptSecret(`v1:${buf.toString("base64")}`, "revolut.refresh_token", "auth-secret-1"));
  assert.throws(() => encryptSecret("x", "n", ""), /AUTH_SECRET/);
});

// ---------- certificate and JWT ----------

test("self-signed X.509 certificate: parses, is self-signed by the key, valid 5 years", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  const pem = selfSignedCertificate(keys.privateKeyPem, { now });
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/);
  const cert = new X509Certificate(pem);
  assert.ok(cert.verify(createPublicKey(keys.publicKeyPem)), "signature checks out with the public key");
  assert.ok(cert.checkPrivateKey(createPrivateKey(keys.privateKeyPem)));
  assert.match(cert.subject, /CN=1Media OS/);
  assert.equal(cert.subject, cert.issuer);
  const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000;
  assert.ok(days > 1824 && days < 1826, `valid ${days} days`);
  assert.ok(!pem.includes("PRIVATE"));
});

test("JWT client assertion: RS256, Revolut claims, signature verifies with the public key", () => {
  const jwt = clientAssertion({ clientId: "client_abc123XYZ", issuer: issuerFor("https://1media2027.vercel.app/api/revolut/callback"), privateKey: keys.privateKeyPem, now: 1_800_000_000_000 });
  const [h, p, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), {
    iss: "1media2027.vercel.app",
    sub: "client_abc123XYZ",
    aud: "https://revolut.com",
    iat: 1_800_000_000,
    exp: 1_800_000_300,
  });
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(keys.publicKeyPem), Buffer.from(sig, "base64url")));
  assert.ok(!verify("sha256", Buffer.from(`${h}.${p}x`), createPublicKey(keys.publicKeyPem), Buffer.from(sig, "base64url")));
});

test("consent URL and base URLs follow REVOLUT_ENV; redirect URI defaults to this site", () => {
  const prod = new URL(consentUrl({ clientId: "cid12345", redirectUri: "https://1media2027.vercel.app/api/revolut/callback", state: "s1", env: {} }));
  assert.equal(prod.origin + prod.pathname, "https://business.revolut.com/app-confirm");
  assert.equal(prod.searchParams.get("client_id"), "cid12345");
  assert.equal(prod.searchParams.get("redirect_uri"), "https://1media2027.vercel.app/api/revolut/callback");
  assert.equal(prod.searchParams.get("response_type"), "code");
  assert.equal(prod.searchParams.get("scope"), "READ");
  assert.equal(prod.searchParams.get("state"), "s1");
  assert.match(consentUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s", env: { REVOLUT_ENV: "sandbox" } }), /^https:\/\/sandbox-business\.revolut\.com\/app-confirm\?/);
  assert.equal(revolutUrls({}).api, "https://b2b.revolut.com/api/1.0");
  assert.equal(revolutUrls({ REVOLUT_ENV: "sandbox" }).api, "https://sandbox-b2b.revolut.com/api/1.0");
  assert.equal(redirectUriFor("https://1media2027.vercel.app/", {}), "https://1media2027.vercel.app/api/revolut/callback");
  assert.equal(redirectUriFor("http://localhost:3000", { REVOLUT_REDIRECT_URI: "https://os.1media.ie/api/revolut/callback" }), "https://os.1media.ie/api/revolut/callback");
});

// ---------- token endpoint (HTTP mocked) ----------

type Call = { url: string; init?: RequestInit };
function mockFetch(responses: (call: Call) => Response) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responses({ url, init });
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const creds = (f: (url: string, init?: RequestInit) => Promise<Response>) => ({ clientId: "client_abc123XYZ", issuer: "1media2027.vercel.app", privateKey: keys.privateKeyPem, fetch: f, env: {}, now: 1_800_000_000_000 });

test("code exchange: posts a signed client assertion, returns both tokens with expiry", async () => {
  const { f, calls } = mockFetch(() => json({ access_token: "oa_prod_ACCESS", token_type: "bearer", expires_in: 2399, refresh_token: "oa_prod_REFRESH" }));
  const t = await exchangeCode("code-xyz", creds(f));
  assert.equal(calls[0].url, "https://b2b.revolut.com/api/1.0/auth/token");
  assert.equal(calls[0].init?.method, "POST");
  const form = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code-xyz");
  assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  const [h, p, sig] = form.get("client_assertion")!.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(keys.publicKeyPem), Buffer.from(sig, "base64url")));
  assert.equal(t.accessToken, "oa_prod_ACCESS");
  assert.equal(t.refreshToken, "oa_prod_REFRESH");
  assert.equal(t.accessTokenExpiresAt.getTime(), 1_800_000_000_000 + 2_399_000);
});

test("refresh: refresh_token grant; a rejected refresh token is an auth error (re-authorise), 5xx is not", async () => {
  const ok = mockFetch(() => json({ access_token: "new-access", expires_in: 2399 }));
  const t = await refreshAccessToken("old-refresh", creds(ok.f));
  const form = new URLSearchParams(String(ok.calls[0].init?.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "old-refresh");
  assert.equal(t.accessToken, "new-access");
  assert.equal(t.refreshToken, undefined);

  const dead = mockFetch(() => json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400));
  await assert.rejects(refreshAccessToken("old-refresh", creds(dead.f)), (e: unknown) => e instanceof RevolutAuthError && /expired/.test(e.message) && !e.message.includes("old-refresh"));
  const down = mockFetch(() => new Response("bad gateway", { status: 502 }));
  await assert.rejects(refreshAccessToken("old-refresh", creds(down.f)), (e: unknown) => e instanceof RevolutApiError && e.status === 502);
});

// ---------- transaction mapping ----------

const OWN = new Set(["acc-main", "acc-savings"]);
const tx = (over: Partial<RevolutTransaction> & { leg?: Partial<RevolutTransaction["legs"][number]> }): RevolutTransaction => {
  const { leg, ...rest } = over;
  return {
    id: "tx-1",
    type: "card_payment",
    state: "completed",
    created_at: "2026-11-03T10:00:00.000Z",
    completed_at: "2026-11-03T10:00:05.000Z",
    legs: [{ leg_id: "l1", account_id: "acc-main", amount: -11.99, currency: "EUR", description: "Canva", ...leg }],
    ...rest,
  };
};

test("mapTransaction: card payments, fees and foreign currency become expenses", () => {
  const m = mapTransaction(tx({ merchant: { name: "Canva", category_code: "5734" }, card: { card_number: "459999******1234" } }), OWN);
  assert.equal(m.kind, "expense");
  if (m.kind !== "expense") return;
  assert.deepEqual(
    { ...m.items[0], hint: undefined },
    {
      externalId: "revolut:tx-1",
      date: "2026-11-03",
      merchant: "Canva",
      description: null,
      amount: 11.99,
      currency: "EUR",
      amountEur: 11.99,
      revolutAccountId: "acc-main",
      cardLast4: "1234",
      notes: null,
      hint: undefined,
    },
  );
  assert.deepEqual(m.items[0].hint, { type: "card_payment", mcc: "5734" });

  const usd = mapTransaction(tx({ id: "tx-usd", merchant: { name: "Midjourney" }, leg: { amount: -27.6, currency: "EUR", bill_amount: -30, bill_currency: "USD", fee: 0.5 } }), OWN);
  assert.equal(usd.kind, "expense");
  if (usd.kind !== "expense") return;
  assert.equal(usd.items[0].amountEur, 27.6);
  assert.match(usd.items[0].description ?? "", /30\.00 USD/);
  assert.deepEqual([usd.items[1].externalId, usd.items[1].amount, usd.items[1].hint?.type], ["revolut:tx-usd:fee", 0.5, "FEE"]);

  const gbpAccount = mapTransaction(tx({ id: "tx-gbp", leg: { amount: -20, currency: "GBP" } }), OWN);
  assert.ok(gbpAccount.kind === "expense" && gbpAccount.items[0].amountEur === null);

  const fee = mapTransaction(tx({ id: "tx-fee", type: "fee", leg: { amount: -25, description: "Grow plan fee" } }), OWN);
  assert.ok(fee.kind === "expense" && fee.items[0].merchant === "Grow plan fee" && fee.items[0].hint?.type === "fee");

  const out = mapTransaction(tx({ id: "tx-tr", type: "transfer", reference: "Oct creatives", leg: { amount: -600, description: "To Niamh Designs", counterparty: { account_type: "external", id: "cp1" } } }), OWN);
  assert.ok(out.kind === "expense" && out.items[0].merchant === "Niamh Designs" && out.items[0].description === "To Niamh Designs · Oct creatives");
});

test("mapTransaction: own transfers, exchanges, pending and refunds are skipped; money in is a credit", () => {
  assert.deepEqual(mapTransaction(tx({ type: "transfer", leg: { amount: -2000, counterparty: { account_type: "self", account_id: "acc-savings" } } }), OWN), { kind: "skip", reason: "own transfer" });
  assert.deepEqual(mapTransaction(tx({ type: "transfer", leg: { amount: -2000, counterparty: { account_id: "acc-savings" } } }), OWN), { kind: "skip", reason: "own transfer" });
  assert.deepEqual(mapTransaction(tx({ type: "exchange" }), OWN), { kind: "skip", reason: "own transfer" });
  assert.deepEqual(mapTransaction(tx({ state: "pending" }), OWN), { kind: "skip", reason: "not completed" });
  assert.deepEqual(mapTransaction(tx({ state: "reverted" }), OWN), { kind: "skip", reason: "not completed" });
  assert.deepEqual(mapTransaction(tx({ type: "card_refund", leg: { amount: 11.99 } }), OWN), { kind: "skip", reason: "other type" });
  const inc = mapTransaction(tx({ id: "tx-in", type: "transfer", reference: "1MEDIA NOV", leg: { amount: 1845, description: "Money added from DEMO PAVING CO", counterparty: { account_type: "external" } } }), OWN);
  assert.deepEqual(inc, {
    kind: "income",
    credit: { externalId: "revolut:tx-in", date: "2026-11-03", amount: 1845, currency: "EUR", payer: "DEMO PAVING CO", reference: "1MEDIA NOV", description: "Money added from DEMO PAVING CO" },
  });
});
