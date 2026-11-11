import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixtureFetch, queryAll, type FetchLike, type NotionPage } from "../src/lib/notion-import/notion";
import {
  fromCrm, fromMonthly, fromPayment, fromPortal, groupClients, normaliseEmail, normaliseName, paymentLabel, planClients, planPayments, portalStatus,
  type ClientRecord, type ExistingClient, type ExistingPayment, type PaymentDraft,
} from "../src/lib/notion-import/plan";
import { runImport, type Store } from "../src/lib/notion-import/run";
import { formatReport } from "../src/lib/notion-import/report";

const FIXTURES = join(import.meta.dirname, "fixtures/notion");
const TODAY = "2026-11-11";

// ---------- tiny Notion page builders ----------
const rt = (s: string | null) => (s === null ? [] : [{ plain_text: s }]);
const P = {
  title: (s: string | null) => ({ type: "title", title: rt(s) }),
  text: (s: string | null) => ({ type: "rich_text", rich_text: rt(s) }),
  email: (s: string | null) => ({ type: "email", email: s }),
  num: (n: number | null) => ({ type: "number", number: n }),
  select: (s: string | null) => ({ type: "select", select: s ? { name: s } : null }),
  status: (s: string | null) => ({ type: "status", status: s ? { name: s } : null }),
  multi: (a: string[]) => ({ type: "multi_select", multi_select: a.map((name) => ({ name })) }),
  date: (s: string | null) => ({ type: "date", date: s ? { start: s } : null }),
  check: (b: boolean) => ({ type: "checkbox", checkbox: b }),
  rel: (ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) }),
};
const page = (id: string, properties: NotionPage["properties"], extra: Partial<NotionPage> = {}): NotionPage => ({ id, properties, ...extra });
const rec = (source: ClientRecord["source"], pageId: string, name: string, extra: Partial<ClientRecord> & { email?: string } = {}): ClientRecord => ({
  source,
  pageId,
  label: name,
  links: extra.links ?? [],
  fields: { name, ...(extra.email ? { email: extra.email } : {}), ...extra.fields },
});

// ---------- normalising ----------

test("normaliseName ignores case, punctuation, accents, '&' and company suffixes", () => {
  assert.equal(normaliseName("Greenfield Paving Ltd."), "greenfield paving");
  assert.equal(normaliseName("  greenfield   PAVING "), "greenfield paving");
  assert.equal(normaliseName("The Óak & Ash Co. Limited"), "oak and ash");
  assert.equal(normaliseName("Oakline Attic Conversions."), "oakline attic conversions");
  assert.equal(normaliseName("housemoving.ie"), "housemoving");
  assert.equal(normaliseName("Ltd"), "ltd"); // never normalises to nothing
  assert.equal(normaliseName(null), "");
});

test("normaliseEmail lowercases and rejects junk", () => {
  assert.equal(normaliseEmail(" Pat@Example.COM "), "pat@example.com");
  assert.equal(normaliseEmail("mailto:pat@example.com"), "pat@example.com");
  assert.equal(normaliseEmail("not an email"), "");
  assert.equal(normaliseEmail(null), "");
});

// ---------- mapping ----------

test("portal status: end date, Active box, then Status tags, then recent payments", () => {
  const s = (props: NotionPage["properties"], recent = false) => portalStatus(page("p", props), recent, TODAY);
  assert.equal(s({ "End Date": P.date("2026-08-31"), Active: P.check(true) }), "churned");
  assert.equal(s({ Active: P.check(true), Status: P.multi(["On Hold"]) }), "active");
  assert.equal(s({ Status: P.multi(["Completed"]) }), "churned");
  assert.equal(s({ Status: P.multi(["Ongoing"]) }), "active");
  assert.equal(s({ Status: P.multi(["On Hold"]) }), "paused");
  assert.equal(s({ Status: P.multi(["Upcoming"]) }), "onboarding");
  assert.equal(s({}, true), "active");
  assert.equal(s({}), "paused");
});

test("portal mapping takes retainer, VAT and method from the latest retainer row, config from the portal", () => {
  const latest = page("pay", { "Retainer (ex VAT)": P.num(1400), VAT: P.select("Inc VAT"), Method: P.select("Revolut") });
  const r = fromPortal(
    page("p1", {
      Name: P.title("Acme Paving"),
      Email: P.email("Hi@Acme.example"),
      Price: P.num(999),
      "Billing Method": P.select("Stripe"),
      "CPL Target": P.num(12.5),
      "Meta Ad Account IDs": P.text("act_1, act_2"),
      "Report Currency": P.select("USD"),
      "Report Greeting": P.text(null),
      Status: P.multi(["Ongoing"]),
    }),
    latest,
    new Set(),
    TODAY,
  );
  assert.ok(!("reason" in r));
  assert.deepEqual(r.fields, {
    name: "Acme Paving",
    status: "active",
    email: "hi@acme.example",
    retainerExVat: 1400,
    vat: "inc",
    billingMethod: "stripe", // portal's own Billing Method wins over the payment row
    cplTarget: 12.5,
    metaAdAccountIds: "act_1, act_2",
    reportCurrency: "USD",
  });
  // Without a payment row the portal's Price is the retainer.
  const r2 = fromPortal(page("p2", { Name: P.title("B"), Price: P.num(999) }), undefined, new Set(), TODAY);
  assert.ok(!("reason" in r2) && r2.fields.retainerExVat === 999);
});

test("rows that aren't clients are skipped with a reason", () => {
  assert.match((fromPortal(page("a", { Name: P.title("X") }, { in_trash: true }), undefined, new Set(), TODAY) as { reason: string }).reason, /archived/);
  assert.match((fromPortal(page("b", { Name: P.title(null) }), undefined, new Set(), TODAY) as { reason: string }).reason, /no name/);
  assert.match((fromCrm(page("c", { Name: P.title("Lead Person"), Stage: P.status("Proposal") })) as { reason: string }).reason, /prospect.*Proposal/);
  assert.match((fromMonthly(page("d", { Name: P.title(null) })) as { reason: string }).reason, /no name/);
});

test("Sales CRM: Company is the client name, the person becomes the contact", () => {
  const r = fromCrm(page("c", { Name: P.title("Pat Murphy"), Company: P.text("Greenfield Paving"), Email: P.email("PAT@g.example"), Stage: P.status("Won"), "Client Portals WON": P.rel(["p1"]) }));
  assert.ok(!("reason" in r));
  assert.equal(r.fields.name, "Greenfield Paving");
  assert.equal(r.fields.contactName, "Pat Murphy");
  assert.equal(r.fields.email, "pat@g.example");
  assert.deepEqual(r.links, ["p1"]);
});

test("payment line labels", () => {
  assert.equal(paymentLabel("Greenfield – Nov"), "Retainer");
  assert.equal(paymentLabel("Harbour – AI retainer Nov"), "AI retainer");
  assert.equal(paymentLabel("Harbour – Website set-up"), "Setup fee");
  assert.equal(paymentLabel("Deposit for build"), "Deposit");
  assert.equal(paymentLabel("Maintenance (fair price)"), "Retainer"); // "ai" inside a word isn't AI
});

test("payment mapping: period from due date, Paid tick without amount means paid in full", () => {
  const groups = new Map([["p1", "g1"]]);
  const d = fromPayment(page("x", { Payment: P.title("Acme – Nov"), Client: P.rel(["p1"]), "Due Date": P.date("2026-11-05T09:00:00.000+00:00"), "Amount Due": P.num(500), "Amount Collected": P.num(null), Paid: P.check(true), Method: P.select("AIB") }), groups) as PaymentDraft;
  assert.equal(d.period, "2026-11-01");
  assert.equal(d.dueDate, "2026-11-05");
  assert.equal(d.amountCollected, 500);
  assert.equal(d.inferredPaid, true);
  assert.equal(d.method, "aib");
  const unpaid = fromPayment(page("y", { Payment: P.title("Acme – Oct"), Client: P.rel(["p1"]), "Due Date": P.date("2026-10-01"), "Amount Due": P.num(500), Paid: P.check(false) }), groups) as PaymentDraft;
  assert.equal(unpaid.amountCollected, 0);
  assert.equal(unpaid.inferredPaid, false);
  assert.match((fromPayment(page("z", { Payment: P.title("?"), Client: P.rel(["nope"]), "Due Date": P.date("2026-10-01"), "Amount Due": P.num(1) }), groups) as { reason: string }).reason, /isn't in Client Portals/);
});

// ---------- dedupe ----------

test("dedupe: same normalised name, explicit links and shared email merge; portal data wins", () => {
  const groups = groupClients([
    rec("portals", "p1", "Greenfield Paving Ltd", { email: "pat@g.example", fields: { name: "Greenfield Paving Ltd", reportRules: "Portal rules", cplTarget: 15 } }),
    rec("monthly", "m1", "Greenfield paving", { fields: { name: "Greenfield paving", reportRules: "Monthly rules", website: "https://g.example" } }),
    rec("crm", "c1", "Bright Water Bath & Tile", { email: "CIARA@b.example", fields: { name: "Bright Water Bath & Tile", phone: "087" } }),
    rec("portals", "p2", "Brightwater Bathrooms", { email: "ciara@b.example" }),
    rec("crm", "c2", "Some Company", { links: ["p3"] }),
    rec("portals", "p3", "Totally Different Name"),
  ]);
  assert.equal(groups.length, 3);
  const g = groups.find((x) => x.notionIds.includes("p1"))!;
  assert.deepEqual(g.notionIds.sort(), ["m1", "p1"]);
  assert.equal(g.fields.name, "Greenfield Paving Ltd");
  assert.equal(g.fields.reportRules, "Portal rules");
  assert.equal(g.fields.website, "https://g.example"); // filled from the lower-priority list
  assert.equal(g.disagreements.length, 1);
  const b = groups.find((x) => x.notionIds.includes("p2"))!;
  assert.equal(b.fields.name, "Brightwater Bathrooms");
  assert.equal(b.fields.phone, "087");
  assert.equal(b.key, "p2"); // portal first
  assert.ok(groups.find((x) => x.notionIds.includes("c2"))!.notionIds.includes("p3"));
});

test("dedupe: two portal pages sharing only an email stay separate", () => {
  const groups = groupClients([rec("portals", "p1", "Alpha Roofing", { email: "accounts@bookkeeper.example" }), rec("portals", "p2", "Beta Windows", { email: "accounts@bookkeeper.example" })]);
  assert.equal(groups.length, 2);
});

// ---------- planning against the database ----------

test("planClients matches existing clients by Notion id, then name, then email, and only fills blanks", () => {
  const [g] = groupClients([rec("portals", "p1", "Acme Paving", { email: "a@acme.example", fields: { name: "Acme Paving", cplTarget: 15, ghlLocationId: "loc_1", reportGreeting: "Hi Pat", retainerExVat: 1000 } })]);
  const base = { email: null, notionIds: [] as string[], cplTarget: null, ghlLocationId: null, reportGreeting: "Hi guys", retainerExVat: 0 };
  const [create] = planClients([g], []);
  assert.equal(create.kind, "create");

  const [byName] = planClients([g], [{ ...base, id: 7, name: "ACME PAVING LTD", cplTarget: 20 } as ExistingClient]);
  assert.equal(byName.kind, "update");
  assert.ok(byName.kind === "update");
  assert.equal(byName.matchedBy, "name");
  assert.deepEqual(byName.set, { email: "a@acme.example", retainerExVat: 1000, ghlLocationId: "loc_1", reportGreeting: "Hi Pat" }); // cplTarget 20 kept
  assert.deepEqual(byName.notionIds, ["p1"]);

  const [byEmail] = planClients([g], [{ ...base, id: 8, name: "Renamed Since", email: "A@acme.example" } as ExistingClient]);
  assert.ok(byEmail.kind === "update" && byEmail.matchedBy === "email");

  const [done] = planClients([g], [{ ...base, id: 9, name: "Acme (renamed in OS)", email: "a@acme.example", notionIds: ["p1"], cplTarget: 15, ghlLocationId: "loc_1", reportGreeting: "Hi Pat", retainerExVat: 1000 } as ExistingClient]);
  assert.equal(done.kind, "unchanged");
  assert.ok(done.kind === "unchanged" && done.matchedBy === "Notion id");
});

const draft = (o: Partial<PaymentDraft>): PaymentDraft => ({
  notionPageId: "n1", clientKey: "g1", title: "Acme – Nov", label: "Retainer", period: "2026-11-01", amountDue: 1230, amountCollected: 0,
  dueDate: "2026-11-01", paidDate: null, method: null, notes: null, inferredPaid: false, ...o,
});
const row = (o: Partial<ExistingPayment>): ExistingPayment => ({ id: 1, clientId: 5, period: "2026-11-01", label: "Retainer", amountDue: 1230, amountCollected: 0, paidDate: null, method: "stripe", notes: null, notionPageId: null, ...o });

test("planPayments fills the billing job's row instead of duplicating it", () => {
  const ids = new Map([["g1", 5]]);
  const [a] = planPayments([draft({ amountCollected: 1230, paidDate: "2026-11-03", method: "invoice", notes: "paid" })], ids, [row({})]);
  assert.equal(a.kind, "merge");
  assert.ok(a.kind === "merge");
  assert.deepEqual(a.set, { notionPageId: "n1", amountCollected: 1230, paidDate: "2026-11-03", notes: "paid" }); // method kept
});

test("planPayments never lowers or overwrites money already recorded in 1Media OS", () => {
  const ids = new Map([["g1", 5]]);
  const [a] = planPayments([draft({ amountCollected: 0, amountDue: 1000 })], ids, [row({ amountCollected: 1230, paidDate: "2026-11-02", notionPageId: "n1" })]);
  assert.equal(a.kind, "unchanged");
  assert.ok(a.kind === "unchanged" && /amount due differs/.test(a.notes.join()));
  const [b] = planPayments([draft({ amountCollected: 500 })], ids, [row({ amountCollected: 1230, notionPageId: "n1" })]);
  assert.ok(b.kind === "unchanged" && /kept €1230/.test(b.notes.join()));
});

test("planPayments: new rows, re-runs and duplicate Notion rows", () => {
  const ids = new Map([["g1", 5]]);
  const plan = planPayments([draft({}), draft({ notionPageId: "n2", title: "Acme – Nov (copy)" }), draft({ notionPageId: "n3", period: "2026-10-01" })], ids, []);
  assert.deepEqual(plan.map((p) => p.kind), ["create", "skip", "create"]);
  // A re-run sees its own rows by Notion id.
  const again = planPayments([draft({})], ids, [row({ notionPageId: "n1" })]);
  assert.equal(again[0].kind, "unchanged");
  // A row imported from another Notion page holds the slot: the newcomer is skipped, not merged.
  const clash = planPayments([draft({ notionPageId: "n9" })], ids, [row({ notionPageId: "n1" })]);
  assert.equal(clash[0].kind, "skip");
});

// ---------- Notion client ----------

test("queryAll follows pagination, retries on 429 and only calls the query endpoint", async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  let first = true;
  const base = fixtureFetch(FIXTURES);
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (first) {
      first = false;
      return { ok: false, status: 429, headers: { get: () => "0" }, json: async () => ({}), text: async () => "slow down" };
    }
    return base(url, init);
  };
  const rows = await queryAll("f0598ec7-8dd1-8365-bc03-877e4a61c759", { token: "t", fetch: f, sleep: async () => {} });
  assert.equal(rows.length, 9);
  assert.equal(calls.length, 3); // 429, page 1, page 2
  assert.ok(calls.every((c) => c.method === "POST" && /\/v1\/data_sources\/[^/]+\/query$/.test(c.url)));
  assert.equal(JSON.parse(calls[2].body).start_cursor, "cursor-5");
  await assert.rejects(queryAll("../pages/abc", { token: "t", fetch: f }), /unexpected data source id/);
});

// ---------- end to end on fixtures ----------

/** In-memory stand-in for Postgres with the same unique keys as the real tables. */
function memoryStore(clients: ExistingClient[] = [], payments: ExistingPayment[] = []): Store & { clientsRows: ExistingClient[]; paymentRows: ExistingPayment[] } {
  let nextId = 100;
  const s = {
    clientsRows: clients,
    paymentRows: payments,
    clients: async () => structuredClone(s.clientsRows),
    payments: async () => structuredClone(s.paymentRows),
    write: async (fn: Parameters<Store["write"]>[0]) => {
      const snapshot = structuredClone({ c: s.clientsRows, p: s.paymentRows });
      try {
        await fn({
          createClient: async (v) => {
            const id = nextId++;
            s.clientsRows.push({ reportGreeting: "Hi guys", retainerExVat: 0, email: null, ...v, id } as ExistingClient);
            return id;
          },
          updateClient: async (id, set, notionIds) => void Object.assign(s.clientsRows.find((c) => c.id === id)!, set, { notionIds }),
          createPayment: async (v) => {
            if (s.paymentRows.some((p) => p.clientId === v.clientId && p.period === v.period && p.label === v.label)) throw new Error("unique violation");
            s.paymentRows.push({ id: nextId++, clientId: v.clientId, period: v.period, label: v.label, amountDue: v.amountDue, amountCollected: v.amountCollected, paidDate: v.paidDate, method: v.method, notes: v.notes, notionPageId: v.notionPageId });
          },
          updatePayment: async (id, set) => void Object.assign(s.paymentRows.find((p) => p.id === id)!, set),
        });
      } catch (e) {
        s.clientsRows = snapshot.c;
        s.paymentRows = snapshot.p;
        throw e;
      }
    },
  };
  return s;
}

const run = (store: Store | null, dryRun = false) => runImport({ dryRun, token: "t", store, fetch: fixtureFetch(FIXTURES), today: TODAY, env: {} });

test("fixtures: dry run plans 8 clients and 10 payments and writes nothing", async () => {
  const store = memoryStore();
  const r = await run(store, true);
  assert.equal(r.clients.filter((a) => a.kind === "create").length, 8);
  assert.equal(r.clientSkips.length, 3);
  assert.equal(r.payments.filter((a) => a.kind === "create").length, 10);
  assert.equal(r.paymentSkips.length + r.payments.filter((a) => a.kind === "skip").length, 4);
  assert.equal(store.clientsRows.length, 0);
  assert.equal(store.paymentRows.length, 0);
  const text = formatReport(r);
  assert.match(text, /DRY RUN/);
  assert.match(text, /Greenfield Paving Ltd ← Client Portals "Greenfield Paving Ltd" \+ Client Portals "Greenfield Paving" \+ Sales CRM/);
  assert.match(text, /Walsh Extensions": prospect/);
  assert.match(text, /Address \(2 rows\): no address columns/);
  assert.match(text, /Sales CRM › Priority \(1 row\)/); // only the Won client's; the prospect's sales fields aren't gaps
});

test("fixtures: dry run works with no database at all", async () => {
  const r = await run(null, true);
  assert.ok(r.plannedAgainstEmptyDb);
  assert.match(formatReport(r), /No DATABASE_URL/);
  await assert.rejects(run(null, false), /needs DATABASE_URL/);
});

test("fixtures: import is idempotent and merges into rows the billing job made", async () => {
  // Before the import, someone added Greenfield by hand and the 1st-of-month billing job made its November row.
  const store = memoryStore(
    [{ id: 1, name: "Greenfield Paving", email: null, notionIds: [], reportGreeting: "Hi guys", retainerExVat: 1400, cplTarget: null } as ExistingClient],
    [{ id: 2, clientId: 1, period: "2026-11-01", label: "Retainer", amountDue: 1722, amountCollected: 0, paidDate: null, method: "stripe", notes: null, notionPageId: null }],
  );
  const first = await run(store);
  assert.equal(first.clients.filter((a) => a.kind === "create").length, 7);
  const gf = first.clients.find((a) => a.kind === "update");
  assert.ok(gf && gf.kind === "update" && gf.matchedBy === "name" && gf.set.cplTarget === 15 && gf.set.reportGreeting === "Hi Pat");
  assert.equal(first.payments.filter((a) => a.kind === "merge").length, 1);
  assert.equal(store.clientsRows.length, 8);
  assert.equal(store.paymentRows.length, 10); // the billing job's row (now filled) + 9 new
  const nov = store.paymentRows.find((p) => p.id === 2)!;
  assert.equal(nov.amountCollected, 1722); // Paid ticked in Notion
  assert.ok(nov.notionPageId);
  const greenfield = store.clientsRows.find((c) => c.id === 1)!;
  assert.equal(greenfield.notionIds.length, 3); // two portal pages + CRM row
  assert.equal(store.clientsRows.find((c) => c.name === "Old Town Roofing")!.status, "churned");

  const before = structuredClone([store.clientsRows, store.paymentRows]);
  const second = await run(store);
  assert.deepEqual([store.clientsRows, store.paymentRows], before);
  assert.ok(second.clients.every((a) => a.kind === "unchanged"));
  assert.ok(second.payments.every((a) => a.kind === "unchanged" || a.kind === "skip"));
  assert.match(formatReport(second), /Clients: 0 new, 0 updated, 8 already up to date/);
});

test("fixtures: an optional list that isn't shared is reported, a required one stops the import", async () => {
  const unshared = (id: string): FetchLike => {
    const base = fixtureFetch(FIXTURES);
    return async (url, init) => (url.includes(id) ? { ok: false, status: 404, json: async () => ({}), text: async () => "object_not_found" } : base(url, init));
  };
  const r = await runImport({ dryRun: true, token: "t", store: null, fetch: unshared("0ff98ec7-8dd1-83d9-b1fc-074d3d9d0316"), today: TODAY, env: {} });
  assert.match(r.sources.find((s) => s.key === "crm")!.error!, /404/);
  assert.equal(r.clients.length, 7); // Kelly Driveways only exists in the CRM
  await assert.rejects(
    runImport({ dryRun: true, token: "t", store: null, fetch: unshared("1596ffdf-32f4-441c-b673-6bb8dd6c43af"), today: TODAY, env: {} }),
    /Couldn't read "Payment Collection"/,
  );
});
