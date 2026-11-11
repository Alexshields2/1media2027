import "../src/config";
import { eq } from "drizzle-orm";
import { db, schema, closeDb } from "../src/db";
import { generateMonth } from "../src/lib/billing";
import { scoreAndSaveHealth } from "../src/lib/health";
import { addMonths, monthStart, weekStart, today } from "../src/lib/dates";

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
      { name: "Demo Paving Co", industry: "Paving", retainerExVat: 1500, vat: "plus", billingMethod: "stripe", cplTarget: 15, contactName: "Pat", email: "pat@example.com", startDate: "2026-03-01" },
      { name: "Demo Attic Conversions", industry: "Attics", retainerExVat: 3000, vat: "plus", billingMethod: "invoice", cplTarget: 10, contactName: "Mary", email: "mary@example.com", startDate: "2026-01-01" },
      { name: "Demo Bathrooms", industry: "Bathrooms", retainerExVat: 406.5, vat: "inc", billingMethod: "invoice", cplTarget: 15, contactName: "John", email: "john@example.com", startDate: "2026-05-01", reportRules: "Do NOT list leads. Give totals only." },
      { name: "Demo Garden Rooms", industry: "Garden rooms", retainerExVat: 900, vat: "plus", billingMethod: "revolut", cplTarget: 12, contactName: "Aoife", email: "aoife@example.com", status: "onboarding", startDate: today() },
    ])
    .returning();

  const now = monthStart();
  await generateMonth(addMonths(now, -1));
  await generateMonth(now);

  // Last month: two paid, one part paid
  const last = await db.select().from(schema.payments);
  for (const p of last.filter((x) => x.period === addMonths(now, -1)).slice(0, 2)) {
    await db.update(schema.payments).set({ amountCollected: p.amountDue, paidDate: `${addMonths(now, -1).slice(0, 8)}05` }).where(eq(schema.payments.id, p.id));
  }

  await db.insert(schema.tasks).values([
    { clientId: clients[0].id, title: "Refresh static ads (creative fatigue)", priority: "high", dueDate: today(), source: "agent" },
    { clientId: clients[1].id, title: "Build long-term nurture flow in GHL", priority: "medium", dueDate: today() },
    { clientId: clients[3].id, title: "Get Meta Business partner access", priority: "high", dueDate: today() },
    { title: "Send Q1 pricing review to Alex", priority: "low" },
  ]);

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
  ];
  for (const [ci, leads, ctr] of past) {
    await db.insert(schema.healthChecks).values(
      leads.map((l, i) => ({
        clientId: clients[ci].id,
        weekOf: weeksAgo(i + 1),
        status: "green" as const,
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

  await db.insert(schema.reports).values({
    clientId: clients[1].id,
    kind: "weekly",
    period: weekStart(),
    leads: 44,
    spend: 392,
    cpl: 8.9,
    body: "Hi guys, this is how we got on last week.\n\nLeads: 44\nAmount spent: €392\nCost per lead: €8.90\nImpressions: 41,220\nLink clicks: 612\n\nA strong week: cost per lead is under target and volume is up. We're adding two new ad angles this week.\n\nWhat we got done this week:\nNew lead form live\n\nStill to do:\nLong-term nurture flow\nWe will get these ticked off today.\n\nJamie",
  });

  console.log(`Seeded ${clients.length} demo clients.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
