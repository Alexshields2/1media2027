import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, dropTestDb, fixture, skipReason } from "./helpers/test-db";
import type { RevolutTransaction } from "../src/lib/revolut/api";

// Expenses and the Revolut Business sync against a throwaway Postgres database. Revolut's HTTP API
// is a fake in this file: no request leaves the machine. Run with TEST_DATABASE_URL set.

/** A tiny fake of Revolut's token, accounts and transactions endpoints. */
function fakeRevolut(txs: RevolutTransaction[]) {
  const state = { refreshOk: true, tokenCalls: 0, txCalls: 0, issued: 0, forms: [] as URLSearchParams[] };
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/auth/token")) {
      state.tokenCalls++;
      const form = new URLSearchParams(String(init?.body));
      state.forms.push(form);
      if (form.get("grant_type") === "refresh_token" && !state.refreshOk) return json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
      state.issued++;
      return json({ access_token: `access-${state.issued}`, token_type: "bearer", expires_in: 2399, ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "refresh-SECRET-1" } : {}) });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith("Bearer access-")) return json({ message: "unauthorised" }, 401);
    if (u.pathname.endsWith("/accounts")) {
      return json([
        { id: "acc-main", name: "EUR Main", currency: "EUR", balance: 1000, state: "active" },
        { id: "acc-savings", name: "EUR Savings", currency: "EUR", balance: 5000, state: "active" },
      ]);
    }
    if (u.pathname.endsWith("/transactions")) {
      state.txCalls++;
      const from = u.searchParams.get("from");
      const to = u.searchParams.get("to");
      const count = Number(u.searchParams.get("count"));
      const page = [...txs]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .filter((t) => (!from || t.created_at >= from) && (!to || t.created_at <= to)) // inclusive "to": the boundary repeats
        .slice(0, count);
      return json(page);
    }
    return json({ message: "not found" }, 404);
  };
  return { f, state };
}

const card = (id: string, at: string, merchant: string, amount: number, mcc?: string): RevolutTransaction => ({
  id,
  type: "card_payment",
  state: "completed",
  created_at: at,
  completed_at: at,
  merchant: { name: merchant, category_code: mcc },
  card: { card_number: "459999******1234" },
  legs: [{ leg_id: `${id}-l`, account_id: "acc-main", amount: -amount, currency: "EUR", description: merchant }],
});

describe("expenses and Revolut sync (database)", { skip: skipReason }, () => {
  let db: typeof import("../src/db");
  let ex: typeof import("../src/lib/expenses");
  let conn: typeof import("../src/lib/revolut/connection");
  let sync: typeof import("../src/lib/revolut/sync");
  let ai: typeof import("../src/lib/expense-ai");
  let os: typeof import("../src/lib/os-tools");
  let paving: { id: number };

  before(async () => {
    await createTestDb();
    process.env.AUTH_SECRET = "test-auth-secret";
    delete process.env.REVOLUT_PRIVATE_KEY;
    delete process.env.REVOLUT_ENV;
    delete process.env.ANTHROPIC_API_KEY;
    db = await import("../src/db");
    ex = await import("../src/lib/expenses");
    conn = await import("../src/lib/revolut/connection");
    sync = await import("../src/lib/revolut/sync");
    ai = await import("../src/lib/expense-ai");
    os = await import("../src/lib/os-tools");
    const billing = await import("../src/lib/billing");
    [paving] = await db.db
      .insert(db.schema.clients)
      .values({ name: "Demo Paving Co", retainerExVat: 1500, vat: "plus", billingMethod: "revolut", contactName: "Pat" })
      .returning({ id: db.schema.clients.id });
    await billing.generateMonth("2026-10-01");
    await billing.generateMonth("2026-11-01");
  });
  after(dropTestDb);

  const all = () => db.db.select().from(db.schema.expenses).orderBy(db.schema.expenses.date, db.schema.expenses.id);
  const byMerchant = async (m: string) => (await all()).filter((e) => e.merchant === m);

  test("CSV import: debits recorded and auto-categorised; re-import adds nothing", async () => {
    const r1 = await ex.importExpenseCsv(fixture("bank/revolut-expenses.csv"));
    assert.equal(r1.debits, 8);
    assert.equal(r1.inserted, 8);
    assert.equal(r1.credits, 2);
    const rows = await all();
    const cat = Object.fromEntries(rows.map((e) => [e.merchant, `${e.category}/${e.categorySource}`]));
    assert.deepEqual(cat, {
      Canva: "software/rule",
      "FACEBK *8XK2PL3QZ": "advertising/rule",
      "Niamh Designs": "null/null",
      "EUR Savings": "transfers/rule",
      Adobe: "software/rule",
      Revolut: "bank_fees/rule",
      "Grow plan fee": "bank_fees/rule",
      "The Hungry Monk": "null/null",
    });
    assert.ok(rows.every((e) => e.source === "csv" && e.amountEur === e.amount));
    assert.equal(r1.uncategorised, 2);

    const r2 = await ex.importExpenseCsv(fixture("bank/revolut-expenses.csv"));
    assert.deepEqual([r2.inserted, r2.duplicates], [0, 8]);
    assert.equal((await all()).length, 8);
  });

  test("category memory: recategorising a merchant once moves its others now and on every future import", async () => {
    const [monk] = await byMerchant("The Hungry Monk");
    // A second Hungry Monk expense, added by hand without a category.
    await ex.addManualExpense({ date: "2026-10-20", merchant: "The Hungry Monk", amount: 30, currency: "EUR" });
    const r = await ex.setExpenseCategory(monk.id, "meals", { userId: undefined });
    assert.equal(r.alsoUpdated, 1);
    const monks = await byMerchant("The Hungry Monk");
    assert.deepEqual(monks.map((e) => [e.category, e.categorySource]).sort(), [["meals", "memory"], ["meals", "owner"]]);
    // Future ones follow (a different reference code, same merchant key).
    await ex.insertExpenses([{ externalId: "manual:monk-3", date: "2026-11-02", merchant: "THE HUNGRY MONK LTD", amount: 12, currency: "EUR" }], "manual");
    const [later] = (await all()).filter((e) => e.externalId === "manual:monk-3");
    assert.deepEqual([later.category, later.categorySource], ["meals", "memory"]);
    // The owner's own per-row choice is never overwritten by memory.
    await ex.setExpenseCategory(later.id, "office", { remember: false });
    await ex.setExpenseCategory(monk.id, "meals");
    assert.equal((await all()).find((e) => e.id === later.id)!.category, "office");
    // Memory never turns an own-account transfer into spending.
    const [savings] = await byMerchant("EUR Savings");
    await ex.insertExpenses([{ externalId: "x:own", date: "2026-10-28", merchant: "Canva", amount: 1, currency: "EUR", hint: { ownTransfer: true } }], "manual");
    assert.equal((await all()).find((e) => e.externalId === "x:own")!.category, "transfers");
    assert.equal(savings.category, "transfers");
  });

  test("month summary and trend leave own transfers out", async () => {
    const s = await ex.monthSummary("2026-10");
    assert.equal(s.byCategory.find((c) => c.category === "transfers")?.total, 2001);
    const counted = (await all()).filter((e) => e.date.startsWith("2026-10") && e.category !== "transfers").reduce((t, e) => t + e.amount, 0);
    assert.equal(s.total, Math.round(counted * 100) / 100);
    const trend = await ex.monthlyTrend("2026-11", 12);
    assert.equal(trend.length, 12);
    assert.equal(trend.at(-2)!.month, "2026-10");
    assert.equal(trend.at(-2)!.total, s.total);
    const csv = await ex.exportExpensesCsv({ month: "2026-10" });
    assert.match(csv, /^Date,Merchant,/);
    assert.equal(csv.trim().split("\r\n").length, 1 + s.count);
  });

  test("Revolut set-up: certificate, client ID, consent state, code exchange; secrets stored encrypted", async () => {
    assert.equal((await conn.currentStatus()).status, "no_key");
    const cert = await conn.ensureKeyAndCertificate();
    assert.match(cert, /BEGIN CERTIFICATE/);
    assert.equal(await conn.ensureKeyAndCertificate(), cert, "stable once made");
    assert.equal((await conn.currentStatus()).status, "needs_client_id");
    await assert.rejects(conn.saveClientId("x y"), /client ID/);
    await conn.saveClientId("client_abc123XYZ");
    assert.equal((await conn.currentStatus()).status, "not_authorised");

    const url = new URL(await conn.startAuthorisation("https://1media2027.vercel.app/api/revolut/callback"));
    const stateParam = url.searchParams.get("state")!;
    assert.ok(stateParam.length >= 30);
    const fake = fakeRevolut([]);
    await assert.rejects(conn.completeAuthorisation("code-1", "forged-state", fake.f), /stale/);
    assert.equal(fake.state.tokenCalls, 0);
    await conn.completeAuthorisation("code-1", stateParam, fake.f);
    assert.equal((await conn.currentStatus()).status, "connected");
    assert.equal(fake.state.forms[0].get("code"), "code-1");

    // Nothing secret in the clear: not the private key, not the tokens.
    const secrets = await db.db.select().from(db.schema.secrets);
    assert.deepEqual(secrets.map((s) => s.name).sort(), ["revolut.access_token", "revolut.private_key", "revolut.refresh_token"]);
    for (const s of secrets) assert.ok(!/refresh-SECRET|access-1|PRIVATE KEY/.test(s.ciphertext), s.name);
    const row = await conn.getConnection();
    assert.ok(!JSON.stringify(row).match(/refresh-SECRET|access-1|PRIVATE KEY/));
    assert.equal(row!.oauthState, null, "state is single-use");
  });

  test("access token: cached while valid, refreshed near expiry, re-auth flagged when the refresh token dies", async () => {
    const fake = fakeRevolut([]);
    const now = Date.now();
    assert.equal(await conn.getAccessToken({ fetch: fake.f, now }), "access-1");
    assert.equal(fake.state.tokenCalls, 0, "cached");
    const later = now + 39 * 60_000 + 30_000; // under a minute left
    const t = await conn.getAccessToken({ fetch: fake.f, now: later });
    assert.equal(t, "access-1");
    assert.equal(fake.state.tokenCalls, 1);
    assert.equal(fake.state.forms[0].get("grant_type"), "refresh_token");
    assert.equal(fake.state.forms[0].get("refresh_token"), "refresh-SECRET-1");

    const dead = fakeRevolut([]);
    dead.state.refreshOk = false;
    await assert.rejects(conn.getAccessToken({ fetch: dead.f, now: later + 3_600_000 }), (e: unknown) => e instanceof Error && e.name === "RevolutAuthError");
    assert.equal((await conn.currentStatus()).status, "needs_reauth");
    assert.equal((await conn.revolutNeedsAttention()).needsReauth, true);
    const run = await import("../src/lib/revolut/run");
    assert.deepEqual(await run.runRevolutSync("manual"), { ok: false, needsReauth: true, skipped: "Revolut needs re-authorising" });

    // Authorising again clears it.
    const url = new URL(await conn.startAuthorisation("https://1media2027.vercel.app/api/revolut/callback"));
    await conn.completeAuthorisation("code-2", url.searchParams.get("state"), fakeRevolut([]).f);
    assert.equal((await conn.currentStatus()).status, "connected");
  });

  test("sync: paginates, writes expenses and unmatched money in, skips own transfers, idempotent, no double count with CSV", async () => {
    const txs: RevolutTransaction[] = [];
    // 1003 small card payments so the sync has to page (1000 per page).
    for (let i = 0; i < 1003; i++) txs.push(card(`bulk-${i}`, new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(), "Canva", 1));
    txs.push(card("t-adobe", "2026-11-05T09:00:00.000Z", "Adobe", 54.99, "5734"));
    txs.push({
      id: "t-own",
      type: "transfer",
      state: "completed",
      created_at: "2026-11-05T10:00:00.000Z",
      legs: [{ account_id: "acc-main", amount: -500, currency: "EUR", description: "To EUR Savings", counterparty: { account_type: "self", account_id: "acc-savings" } }],
    });
    txs.push({
      id: "t-in",
      type: "transfer",
      state: "completed",
      created_at: "2026-11-06T10:00:00.000Z",
      reference: "1MEDIA NOV",
      legs: [{ account_id: "acc-main", amount: 1845, currency: "EUR", description: "Money added from DEMO PAVING CO", counterparty: { account_type: "external" } }],
    });
    txs.push({ ...card("t-pending", "2026-11-07T10:00:00.000Z", "Ryanair", 89.98), state: "pending" });
    // Already imported from the statement CSV: the same Revolut ID must not be added again.
    txs.push(card("7b000000-0001-4000-8000-000000000001", "2026-10-02T09:00:00.000Z", "Canva", 11.99));

    const before = (await all()).length;
    const paymentsBefore = await db.db.select().from(db.schema.payments);
    const fake = fakeRevolut(txs);
    const now = Date.parse("2026-11-14T06:00:00Z");
    const r = await sync.syncRevolut({ fetch: fake.f, now, firstSyncDays: 60 });
    assert.ok(fake.state.txCalls >= 2, "paged");
    assert.equal(r.transactions, txs.length);
    assert.equal(r.expensesAdded, 1004);
    assert.equal(r.incomeAdded, 1);
    assert.equal(r.skippedOwnTransfers, 1);
    assert.equal((await all()).length, before + 1004);
    const [adobe] = (await all()).filter((e) => e.externalId === "revolut:t-adobe");
    assert.deepEqual([adobe.source, adobe.category, adobe.cardLast4, adobe.revolutAccountId], ["revolut", "software", "1234", "acc-main"]);

    // Money in: unmatched with a suggestion, never applied.
    const inc = await db.db.select().from(db.schema.incomingPayments);
    assert.equal(inc.length, 1);
    assert.deepEqual([inc[0].externalId, inc[0].status, inc[0].allocated, inc[0].bankFormat, inc[0].payer], ["revolut:t-in", "unmatched", 0, "revolut", "DEMO PAVING CO"]);
    assert.ok(inc[0].suggestions.length > 0);
    assert.deepEqual(await db.db.select().from(db.schema.payments), paymentsBefore, "payment rows untouched");

    const c = await conn.getConnection();
    assert.equal(c!.syncedThrough!.toISOString(), "2026-11-06T10:00:00.000Z", "cursor ignores the pending transaction");
    assert.deepEqual(c!.accounts.map((a) => a.id), ["acc-main", "acc-savings"]);
    assert.equal(c!.lastError, null);

    // The pending payment completes; the next sync (3-day overlap) picks it up and adds nothing else.
    txs.find((t) => t.id === "t-pending")!.state = "completed";
    const r2 = await sync.syncRevolut({ fetch: fake.f, now: now + 86_400_000 });
    assert.deepEqual([r2.expensesAdded, r2.incomeAdded], [1, 0]);
    const r3 = await sync.syncRevolut({ fetch: fake.f, now: now + 2 * 86_400_000 });
    assert.deepEqual([r3.expensesAdded, r3.incomeAdded], [0, 0]);
  });

  test("Claude categoriser (mocked): fills only uncategorised rows, by merchant, from one batched call", async () => {
    const calls: unknown[] = [];
    const create = async (p: unknown) => {
      calls.push(p);
      const params = p as { messages: { content: string }[]; output_config: { effort: string; format: { type: string } } };
      assert.equal(params.output_config.effort, "low");
      assert.equal(params.output_config.format.type, "json_schema");
      const lines = params.messages[0].content.split("\n").slice(1);
      const items = lines.map((l) => ({ i: Number(l.split(".")[0]), category: /Niamh/.test(l) ? "contractors" : "not-a-category" }));
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ items }) }] } as never;
    };
    const r = await ai.categoriseWithClaude({ create });
    assert.equal(calls.length, 1);
    assert.equal(r.updated, 1);
    const [niamh] = await byMerchant("Niamh Designs");
    assert.deepEqual([niamh.category, niamh.categorySource], ["contractors", "ai"]);
    // Claude doesn't create merchant memory.
    assert.equal((await db.db.select().from(db.schema.expenseMerchantRules)).some((m) => m.merchantKey === niamh.merchantKey), false);
  });

  test("OS_LIST_EXPENSES (read-only tool): month totals by category and rows", async () => {
    const out = JSON.parse(await os.runOsTool("OS_LIST_EXPENSES", { month: "2026-10", category: "software" }));
    assert.equal(out.summary.month, "2026-10");
    assert.ok(out.summary.by_category.some((c: { key: string; excluded_from_total: boolean }) => c.key === "transfers" && c.excluded_from_total));
    assert.ok(out.expenses.length > 0 && out.expenses.every((e: { category: string }) => e.category === "software"));
    await assert.rejects(os.runOsTool("OS_LIST_EXPENSES", { category: "bogus" }), /Invalid input/);
    const { isMoneyTool } = await import("../src/lib/roles");
    assert.ok(isMoneyTool("OS_LIST_EXPENSES"), "team members never get it");
    void paving;
  });
});
