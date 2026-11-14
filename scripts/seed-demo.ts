import "../src/config";
import { eq } from "drizzle-orm";
import { db, schema, closeDb } from "../src/db";
import { amountDue } from "../src/lib/billing";
import { addMonths, eur, monthStart, weekStart, today } from "../src/lib/dates";
import { metaInsights, metaLeadCount } from "../src/lib/fixtures/ads-fixtures";
import { reportWeek, shiftWeek, weekPeriod, deriveMetrics } from "../src/lib/report-metrics";
import { scoreAndSaveHealth } from "../src/lib/health";
import { insertExpenses, type ExpenseInput } from "../src/lib/expenses";

// Fills an EMPTY database with made-up demo data so you can click around.
//   npm run seed:demo

async function main() {
  const existing = await db.select({ id: schema.clients.id }).from(schema.clients).limit(1);
  if (existing.length) {
    console.log("Database already has clients; not seeding demo data.");
    return;
  }

  const clients = await db
    .insert(schema.clients)
    .values([
      { name: "Demo Paving Co", metaAdAccountIds: "act_1001", ghlLocationId: "loc_paving", driveFolderId: "drive_demo_paving", industry: "Paving", retainerExVat: 1500, vat: "plus", billingMethod: "stripe", stripeCustomerId: "cus_DemoPaving", cplTarget: 15, contactName: "Pat", email: "pat@example.com", startDate: "2026-03-01" },
      { name: "Demo Attic Conversions", metaAdAccountIds: "act_2001, act_2002", ghlLocationId: "loc_attics", industry: "Attics", retainerExVat: 3000, vat: "plus", billingMethod: "invoice", cplTarget: 10, contactName: "Mary", email: "mary@example.com", startDate: "2026-01-01" },
      { name: "Demo Bathrooms", metaAdAccountIds: "act_3001", ghlLocationId: "loc_bathrooms", industry: "Bathrooms", retainerExVat: 406.5, vat: "inc", billingMethod: "invoice", cplTarget: 15, contactName: "John", email: "john@example.com", startDate: "2026-05-01", reportRules: "Do NOT list leads. Give totals only." },
      { name: "Demo Garden Rooms", industry: "Garden rooms", retainerExVat: 900, vat: "plus", billingMethod: "revolut", cplTarget: 12, contactName: "Aoife", email: "aoife@example.com", status: "onboarding", startDate: today() },
      // Made-up records under names that have a logo in public/client-logos, so the gallery looks real.
      { name: "Apex Attics", metaAdAccountIds: "act_4001", ghlLocationId: "loc_apex", driveFolderId: "drive_demo_apex", industry: "Attic conversions", website: "example.com", retainerExVat: 2200, vat: "plus", billingMethod: "stripe", stripeCustomerId: "cus_DemoApex", cplTarget: 18, contactName: "Ciaran", email: "ciaran@example.com", startDate: "2025-11-01" },
      { name: "Spraywise", metaAdAccountIds: "act_5001", ghlLocationId: "loc_spraywise", industry: "Spray foam insulation", retainerExVat: 1250, vat: "plus", billingMethod: "invoice", cplTarget: 14, contactName: "Declan", email: "declan@example.com", startDate: "2026-02-01" },
      { name: "Marlor Bathrooms", metaAdAccountIds: "act_6001", ghlLocationId: "loc_marlor", driveFolderId: "drive_demo_marlor", industry: "Bathrooms", retainerExVat: 1800, vat: "plus", billingMethod: "revolut", cplTarget: 16, contactName: "Lorraine", email: "lorraine@example.com", startDate: "2026-04-01" },
      { name: "Crosbie Coaching", metaAdAccountIds: "act_7001", industry: "Business coaching", retainerExVat: 750, vat: "none", billingMethod: "stripe", stripeCustomerId: "cus_DemoCrosbie", cplTarget: 9, contactName: "Shane", email: "shane@example.com", startDate: "2026-06-01" },
      { name: "New Heights Attics and Construction", metaAdAccountIds: "act_8001", ghlLocationId: "loc_newheights", industry: "Attics", retainerExVat: 1600, vat: "plus", billingMethod: "aib", cplTarget: 15, contactName: "Eoin", email: "eoin@example.com", startDate: "2026-07-01" },
      { name: "Snag List Steve", industry: "Snag lists", retainerExVat: 600, vat: "plus", billingMethod: "invoice", cplTarget: 8, contactName: "Steve", email: "steve@example.com", status: "paused", startDate: "2026-03-01" },
    ])
    .returning();

  const inDays = (n: number) => {
    const d = new Date(`${today()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // Payment history, Jan to this month, like the Notion "Payment Collection" log: most months paid on time,
  // some paid late or together, a part payment, a client who stopped paying, a paused client, and a client
  // with two lines a month (retainer + AI assistant).
  const now = monthStart();
  const year = now.slice(0, 4);
  const months: string[] = [];
  for (let m = `${year}-01-01`; m <= now; m = addMonths(m, 1)) months.push(m);
  const pausedFrom: Record<string, string> = { "Snag List Steve": `${year}-07-01` };
  const day = (m: string, d: number) => `${m.slice(0, 8)}${String(d).padStart(2, "0")}`;
  type Plan = { collected?: number; paid?: string; note?: string };
  const plan = (c: (typeof clients)[number], label: string, m: string, due: number): Plan => {
    const ago = months.length - 1 - months.indexOf(m);
    const mm = m.slice(5, 7);
    const full: Plan = { collected: due, paid: day(m, (c.id % 6) + 2) };
    if (ago === 0) return label === "Retainer" && ["Demo Paving Co", "Apex Attics", "Crosbie Coaching", "Demo Attic Conversions"].includes(c.name) ? { ...full, paid: day(m, 4) } : {};
    if (c.name === "Demo Bathrooms" && ago <= 3) return ago === 3 ? { note: "Said they'd pay August and September together." } : {};
    if (ago === 1) {
      if (c.name === "Spraywise") return { collected: 1000, paid: day(m, 12), note: "Part payment. Balance promised with November." };
      if (c.name === "New Heights Attics and Construction" || (c.name === "Apex Attics" && label !== "Retainer")) return {};
      return full;
    }
    if (c.name === "Spraywise" && mm === "06") return { collected: 800, paid: day(m, 20), note: "Paid €800. Balance to follow." };
    if (c.name === "Snag List Steve" && mm === "06") return { note: "Paused from July. June still owed." };
    if (c.name === "Marlor Bathrooms" && mm === "04") return { collected: due, paid: day(addMonths(m, 1), 9), note: "Paid April and May together." };
    if (c.name === "Marlor Bathrooms" && mm === "05") return { collected: due, paid: day(m, 9) };
    if (c.name === "Demo Attic Conversions" && mm === "03") return { collected: due, paid: day(addMonths(m, 1), 20), note: "Paid late, chased twice." };
    return full;
  };
  const paymentRows = [];
  for (const m of months) {
    for (const c of clients) {
      if (c.retainerExVat <= 0 || !c.startDate || c.startDate.slice(0, 7) > m.slice(0, 7)) continue;
      if (pausedFrom[c.name] && m >= pausedFrom[c.name]) continue;
      const lines: [string, number][] = [["Retainer", amountDue(c)]];
      if (c.name === "Apex Attics" && m >= `${year}-06-01`) lines.push(["AI assistant", 121.77]);
      for (const [label, due] of lines) {
        const p = plan(c, label, m, due);
        paymentRows.push({ clientId: c.id, label, period: m, amountDue: due, amountCollected: p.collected ?? 0, dueDate: m, paidDate: p.paid ?? null, method: c.billingMethod, notes: p.note ?? null });
      }
    }
  }
  if (paymentRows.length) await db.insert(schema.payments).values(paymentRows);

  const [apex, spraywise, marlor, crosbie, newHeights] = clients.slice(4);

  // Stripe payments waiting for the owner to say which month they cover (never applied automatically):
  // Crosbie paying December ahead, Apex's October AI line paid late, and Spraywise's October balance from a
  // Stripe customer that isn't linked to the client yet.
  await db.insert(schema.incomingPayments).values([
    { source: "stripe", externalId: "in_DemoCrosbieDec@75000", receivedDate: inDays(-2), amount: 750, payer: "Crosbie Coaching", reference: "1M-0061", description: "Stripe invoice 1M-0061", stripeCustomerId: "cus_DemoCrosbie", stripeInvoiceId: "in_DemoCrosbieDec", clientId: crosbie.id },
    { source: "stripe", externalId: "in_DemoApexAiOct@12177", receivedDate: inDays(-4), amount: 121.77, payer: "Apex Attics", reference: "1M-0058", description: "Stripe invoice 1M-0058", stripeCustomerId: "cus_DemoApex", stripeInvoiceId: "in_DemoApexAiOct", clientId: apex.id },
    { source: "stripe", externalId: "in_DemoSprayOct@53750", receivedDate: inDays(-1), amount: 537.5, payer: "Spraywise Insulation Ltd", reference: "1M-0063", description: "Stripe invoice 1M-0063", stripeCustomerId: "cus_DemoSpray", stripeInvoiceId: "in_DemoSprayOct", notes: "No client has Stripe customer cus_DemoSpray. Pick the client when you assign it (you can save the customer ID on them)." },
  ]);
  await db.insert(schema.tasks).values([
    { assignee: "Jamie", clientId: clients[0].id, title: "Refresh static ads (creative fatigue)", priority: "high", dueDate: today(), source: "agent", details: "Frequency is 3.4 and CTR is down 18% on the last 4 weeks. Swap in 3 new statics." },
    { assignee: "Niamh", clientId: clients[1].id, title: "Build long-term nurture flow in GHL", priority: "medium", dueDate: today() },
    { assignee: "Alex", clientId: clients[3].id, title: "Get Meta Business partner access", priority: "high", dueDate: today() },
    { assignee: "Jamie", title: "Send Q1 pricing review to Alex", priority: "low" },
    { assignee: "Niamh", clientId: clients[2].id, title: "Call John about untouched leads", priority: "high", dueDate: inDays(-2), source: "agent" },
    { assignee: "Alex", clientId: apex.id, title: "Draft December offer creative", priority: "medium", dueDate: inDays(3) },
    { assignee: "Jamie", clientId: spraywise.id, title: "Chase October balance (€537.50)", priority: "high", dueDate: inDays(-1), source: "agent" },
    { assignee: "Niamh", clientId: newHeights.id, title: "Install Meta pixel on new landing page", priority: "medium", dueDate: inDays(6) },
    { assignee: "Alex", clientId: marlor.id, title: "Shoot before/after video at Rathfarnham job", priority: "low", dueDate: inDays(12) },
    { assignee: "Jamie", clientId: apex.id, title: "Launch Black Friday campaign", status: "in_progress", priority: "high", dueDate: inDays(1) },
    { assignee: "Niamh", clientId: crosbie.id, title: "Rewrite webinar lead form questions", status: "in_progress", priority: "medium", dueDate: inDays(4) },
    { assignee: "Alex", clientId: clients[0].id, title: "Set up missed-call text-back", status: "in_progress", priority: "low", dueDate: inDays(9) },
    { assignee: "Jamie", clientId: marlor.id, title: "November report: check CPL breakdown", status: "review", priority: "medium", dueDate: today() },
    { assignee: "Niamh", clientId: spraywise.id, title: "New lookalike audience from 2025 customers", status: "review", priority: "medium", dueDate: inDays(2), source: "agent" },
    { assignee: "Alex", clientId: crosbie.id, title: "Onboarding call notes into OS", status: "done", priority: "low", completedAt: new Date(Date.now() - 2 * 86_400_000) },
    { assignee: "Jamie", clientId: apex.id, title: "Swap hero image on landing page", status: "done", priority: "medium", completedAt: new Date(Date.now() - 86_400_000) },
    { assignee: "Niamh", clientId: clients[1].id, title: "Weekly report sent", status: "done", priority: "low", source: "agent", completedAt: new Date(Date.now() - 4 * 86_400_000) },
  ]);

  // A month of finished work, so the team ratings have something to go on (some late).
  const doneAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const doneHistory: { who: string; due: number; done: number }[] = [
    { who: "Jamie", due: 3, done: 4 }, { who: "Jamie", due: 8, done: 9 }, { who: "Jamie", due: 12, done: 13 }, { who: "Jamie", due: 18, done: 19 }, { who: "Jamie", due: 22, done: 24 }, { who: "Jamie", due: 26, done: 27 }, { who: "Jamie", due: 9, done: 6 },
    { who: "Niamh", due: 5, done: 6 }, { who: "Niamh", due: 11, done: 12 }, { who: "Niamh", due: 15, done: 10 }, { who: "Niamh", due: 20, done: 21 },
    { who: "Alex", due: 6, done: 2 }, { who: "Alex", due: 14, done: 9 }, { who: "Alex", due: 21, done: 25 },
  ];
  await db.insert(schema.tasks).values(
    doneHistory.map((h, n) => ({
      clientId: clients[n % clients.length].id,
      assignee: h.who,
      title: ["Monthly creative refresh", "Check pixel events", "Send weekly report", "Update GHL pipeline", "Client call follow-up"][n % 5],
      status: "done" as const,
      priority: "medium" as const,
      dueDate: inDays(-h.due),
      completedAt: doneAgo(h.done),
    })),
  );

  // Four past weeks (manual rows, with the numbers), then this week scored by the rules from fixture numbers.
  const weeksAgo = (n: number) => {
    const d = new Date(`${weekStart()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * n);
    return d.toISOString().slice(0, 10);
  };
  const past: [number, number[], number[]][] = [
    // client index, leads for 1..4 weeks ago, CTR % for 1..4 weeks ago
    [0, [24, 26, 22, 25], [1.6, 1.7, 1.5, 1.6]],
    [1, [40, 38, 42, 41], [1.2, 1.1, 1.3, 1.2]],
    [2, [14, 12, 15, 13], [1.0, 1.1, 0.9, 1.0]],
    [4, [31, 29, 33, 30], [1.8, 1.9, 1.7, 1.8]],
    [5, [18, 22, 21, 20], [1.3, 1.4, 1.4, 1.5]],
    [6, [26, 24, 25, 27], [1.4, 1.3, 1.5, 1.4]],
    [7, [52, 47, 49, 45], [2.1, 2.0, 2.2, 2.0]],
    [8, [12, 16, 19, 18], [0.9, 1.0, 1.1, 1.1]],
  ];
  // A little colour in the history: some weeks weren't green.
  const pastStatus: Record<string, "yellow" | "red"> = { "2:1": "yellow", "2:2": "red", "5:2": "yellow", "8:1": "yellow", "0:3": "yellow" };
  for (const [ci, leads, ctr] of past) {
    await db.insert(schema.healthChecks).values(
      leads.map((l, i) => ({
        clientId: clients[ci].id,
        weekOf: weeksAgo(i + 1),
        status: pastStatus[`${ci}:${i + 1}`] ?? ("green" as const),
        leads: l,
        issue: "Everything Healthy",
        reason: "Demo history.",
        source: "manual",
        metrics: { meta: { ctr: ctr[i] } },
      })),
    );
  }
  // Paving: CPL a bit over target and frequency high -> yellow.
  await scoreAndSaveHealth(clients[0].id, { meta: { spend: 386, leads: 21, impressions: 30500, clicks: 440, frequency: 3.4 }, ghl: { newLeads: 21, untouchedOver24h: 0 } }, { source: "demo" });
  // Attics: all good -> green.
  await scoreAndSaveHealth(clients[1].id, { meta: { spend: 392, leads: 44, impressions: 41220, clicks: 612, frequency: 1.8 }, ghl: { newLeads: 44, untouchedOver24h: 0 } }, { source: "demo" });
  // Bathrooms: CPL way over, volume halved, most leads untouched -> red.
  await scoreAndSaveHealth(
    clients[2].id,
    { meta: { spend: 186, leads: 6, impressions: 15000, clicks: 140, frequency: 2.1 }, ghl: { newLeads: 6, untouchedOver24h: 5, untouchedNames: ["Mary Byrne", "Sean Kelly", "Niamh Walsh", "Declan Ryan", "Orla Doyle"] } },
    { source: "demo" },
  );

  await scoreAndSaveHealth(apex.id, { meta: { spend: 540, leads: 32, impressions: 52000, clicks: 940, frequency: 1.9 }, ghl: { newLeads: 32, untouchedOver24h: 0 } }, { source: "demo" });
  await scoreAndSaveHealth(spraywise.id, { meta: { spend: 330, leads: 19, impressions: 26000, clicks: 360, frequency: 3.1 }, ghl: { newLeads: 19, untouchedOver24h: 1, untouchedNames: ["Paul Nolan"] } }, { source: "demo" });
  await scoreAndSaveHealth(marlor.id, { meta: { spend: 410, leads: 27, impressions: 38000, clicks: 520, frequency: 2.0 }, ghl: { newLeads: 27, untouchedOver24h: 0 } }, { source: "demo" });
  await scoreAndSaveHealth(crosbie.id, { meta: { spend: 380, leads: 51, impressions: 61000, clicks: 1280, frequency: 1.6 }, ghl: { newLeads: 51, untouchedOver24h: 0 } }, { source: "demo" });
  await scoreAndSaveHealth(newHeights.id, { meta: { spend: 360, leads: 9, impressions: 21000, clicks: 180, frequency: 2.6 }, ghl: { newLeads: 9, untouchedOver24h: 4, untouchedNames: ["Gary Flynn", "Aine Daly", "Tom Moore", "Rita Kane"] } }, { source: "demo" });

  // A few agent runs so the activity lists aren't empty.
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);
  await db.insert(schema.agentRuns).values([
    { agent: "finance", trigger: "cron", status: "completed", summary: "2 clients overdue. Queued a 7-day chaser for Demo Bathrooms.", toolCalls: 6, proposed: 1, inputTokens: 18200, outputTokens: 940, startedAt: minsAgo(190), finishedAt: minsAgo(189) },
    { agent: "client-health", trigger: "cron", status: "completed", summary: "Scored 9 clients: 2 red, 2 yellow, 5 green.", toolCalls: 14, inputTokens: 26400, outputTokens: 1310, startedAt: minsAgo(160), finishedAt: minsAgo(158) },
    { agent: "inbox", trigger: "manual", status: "completed", summary: "Sorted 23 emails. 1 reply waiting for approval.", toolCalls: 9, proposed: 1, inputTokens: 21000, outputTokens: 1200, startedAt: minsAgo(75), finishedAt: minsAgo(74) },
    { agent: "weekly-report", trigger: "cron", status: "error", error: "Meta Ads: token expired for act_6001.", toolCalls: 3, errors: 1, inputTokens: 5400, outputTokens: 120, startedAt: minsAgo(40), finishedAt: minsAgo(39) },
  ]);

  await db.insert(schema.briefs).values({
    clientId: clients[2].id,
    kind: "call_prep",
    title: `Call prep: Demo Bathrooms, ${today()}`,
    body: "Numbers since the last call: 6 leads, €186 spent, CPL €31 vs €15 target.\n\nTraffic light: red. Leads not worked: 5 of 6 leads untouched for over 24h.\n\nOpen tasks: none.\n\nQuestions to ask:\n1. Did you get to Mary Byrne in Naas? She's been waiting 4 days.\n2. Who is calling the leads on Thursdays and Fridays?\n3. Can we turn on the missed-call text-back in GHL?",
    leads: [
      { name: "Mary Byrne", stage: "New lead", daysSinceContact: 4, untouched: true, source: "Facebook lead form", note: "Naas, full bathroom refit" },
      { name: "Sean Kelly", stage: "New lead", daysSinceContact: 3, untouched: true, source: "Facebook lead form" },
      { name: "Niamh Walsh", stage: "New lead", daysSinceContact: 3, untouched: true, source: "Website" },
      { name: "Declan Ryan", stage: "New lead", daysSinceContact: 2, untouched: true, source: "Facebook lead form" },
      { name: "Orla Doyle", stage: "New lead", daysSinceContact: 2, untouched: true, source: "Facebook lead form" },
      { name: "Ciara Murphy", stage: "Quote sent", daysSinceContact: 1, source: "Facebook lead form" },
    ],
  });
  await db.insert(schema.briefs).values({
    clientId: clients[2].id,
    kind: "inbox",
    title: `Inbox ${today()}`,
    body: "John: asked to add Saturday hours to the lead form. Task created; reply waiting for approval.",
  });
  await db.insert(schema.approvals).values({
    agent: "inbox",
    tool: "GMAIL_REPLY_TO_THREAD",
    input: { thread_id: "demo-thread", recipient_email: "john@example.com", message_body: "Hi John,\n\nNo problem, we'll add Saturday hours to the form today and let you know once it's live.\n\nJamie" },
    reason: "L2 agent: external action (client-facing or money) needs approval.",
  });

  // Five weeks of sent weekly reports with numbers (from the same fixtures the mocked agent reads),
  // so trends and the month-end PDF have data. The latest week is left for the Monday run.
  const history = [];
  for (const c of clients.filter((x) => x.metaAdAccountIds)) {
    for (let w = 5; w >= 1; w--) {
      const p = weekPeriod(shiftWeek(reportWeek().period, -w));
      const rows = c.metaAdAccountIds!.split(",").flatMap((a) => metaInsights(a.trim(), p.start, p.end).data);
      const m = deriveMetrics({
        spend: rows.reduce((n, r) => n + Number(r.spend), 0),
        leads: metaLeadCount(rows),
        impressions: rows.reduce((n, r) => n + Number(r.impressions), 0),
        clicks: rows.reduce((n, r) => n + Number(r.inline_link_clicks), 0),
      });
      history.push({
        clientId: c.id,
        kind: "weekly" as const,
        period: p.period,
        periodStart: p.start,
        periodEnd: p.end,
        ...m,
        status: "sent" as const,
        sentAt: new Date(`${shiftWeek(p.period, 1)}T10:00:00Z`),
        body: `${c.reportGreeting}, this is how we got on last week.\n\nLeads: ${m.leads}\nAmount spent: ${eur(m.spend)}\nCost per lead: ${eur(m.cpl)}\nImpressions: ${m.impressions}\nLink clicks: ${m.clicks}\n\nA steady week.\n\nJamie`,
      });
    }
  }
  await db.insert(schema.reports).values(history);
  // This week's reports: most sent, one still a draft, the rest not written yet.
  const cur = weekPeriod(reportWeek().period);
  await db.insert(schema.reports).values(
    [clients[0], clients[1], apex, crosbie, marlor].map((c, n) => ({
      clientId: c.id,
      kind: "weekly" as const,
      period: cur.period,
      periodStart: cur.start,
      periodEnd: cur.end,
      leads: 20 + n * 4,
      spend: 300 + n * 40,
      cpl: Math.round(((300 + n * 40) / (20 + n * 4)) * 100) / 100,
      status: n === 4 ? ("draft" as const) : ("sent" as const),
      sentAt: n === 4 ? null : new Date(),
      body: `${c.reportGreeting}, this is how we got on last week.\n\nLeads: ${20 + n * 4}\n\nJamie`,
    })),
  );
  await db.insert(schema.briefs).values(
    [apex, crosbie, clients[1]].map((c) => ({ clientId: c.id, kind: "inbox" as const, title: `Inbox ${today()}`, body: "Quick check-in about next week's offer. Replied." })),
  );

  // Made-up expenses for the last 12 months: subscriptions, ad spend, a freelancer, fees, travel.
  const expenses: ExpenseInput[] = [];
  const spend: [string, number, string, string | null][] = [
    ["Canva", 11.99, "CARD_PAYMENT", "5734"],
    ["Google *GSuite 1media", 46.8, "CARD_PAYMENT", "5734"],
    ["Slack Technologies", 26.25, "CARD_PAYMENT", "5734"],
    ["GoHighLevel", 297, "CARD_PAYMENT", "5734"],
    ["FACEBK *DEMO1234", 850, "CARD_PAYMENT", "7311"],
    ["Revolut", 25, "FEE", null],
  ];
  for (let i = 0; i < 12; i++) {
    const m = addMonths(now, -i).slice(0, 7);
    const day = (d: number) => `${m}-${String(d).padStart(2, "0")}`;
    if (day(1) > today()) continue;
    spend.forEach(([merchant, amount, type, mcc], j) =>
      expenses.push({ externalId: `demo:${m}:${j}`, date: day(2 + j * 3), merchant, amount: merchant.startsWith("FACEBK") ? amount + (i % 4) * 120 : amount, currency: "EUR", cardLast4: type === "FEE" ? null : "1234", hint: { type, mcc } }),
    );
    expenses.push({ externalId: `demo:${m}:freelancer`, date: day(25), merchant: "Niamh Designs", description: "To Niamh Designs · Ad creatives", amount: 600 + (i % 3) * 150, currency: "EUR", hint: { type: "TRANSFER" } });
    expenses.push({ externalId: `demo:${m}:savings`, date: day(27), merchant: "EUR Savings", description: "To EUR Savings", amount: 2000, currency: "EUR", hint: { type: "TRANSFER", ownTransfer: true } });
    if (i % 3 === 1) expenses.push({ externalId: `demo:${m}:travel`, date: day(14), merchant: "Ryanair", amount: 89.98, currency: "EUR", cardLast4: "1234", hint: { type: "CARD_PAYMENT", mcc: "3246" } });
    if (i % 4 === 0) expenses.push({ externalId: `demo:${m}:lunch`, date: day(18), merchant: "The Hungry Monk", description: "Client lunch", amount: 64.5, currency: "EUR", cardLast4: "1234", hint: { type: "CARD_PAYMENT" } });
  }
  expenses.push({ externalId: "demo:usd", date: today(), merchant: "Midjourney Inc", amount: 30, currency: "USD", amountEur: 27.6, cardLast4: "1234", hint: { type: "CARD_PAYMENT", mcc: "5734" } });
  const seeded = await insertExpenses(expenses, "manual");
  await db.update(schema.expenses).set({ clientId: apex.id }).where(eq(schema.expenses.merchant, "Niamh Designs"));

  console.log(`Seeded ${clients.length} demo clients and ${seeded.inserted} demo expenses.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
