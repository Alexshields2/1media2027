import "../src/config";
import { eq } from "drizzle-orm";
import { db, schema, closeDb } from "../src/db";
import { generateMonth } from "../src/lib/billing";
import { addMonths, eur, monthStart, weekStart, today } from "../src/lib/dates";
import { metaInsights, metaLeadCount } from "../src/lib/fixtures/ads-fixtures";
import { reportWeek, shiftWeek, weekPeriod, deriveMetrics } from "../src/lib/report-metrics";

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
      { name: "Demo Paving Co", metaAdAccountIds: "act_1001", ghlLocationId: "loc_paving", driveFolderId: "drive_demo_paving", industry: "Paving", retainerExVat: 1500, vat: "plus", billingMethod: "stripe", cplTarget: 15, contactName: "Pat", email: "pat@example.com", startDate: "2026-03-01" },
      { name: "Demo Attic Conversions", metaAdAccountIds: "act_2001, act_2002", ghlLocationId: "loc_attics", industry: "Attics", retainerExVat: 3000, vat: "plus", billingMethod: "invoice", cplTarget: 10, contactName: "Mary", email: "mary@example.com", startDate: "2026-01-01" },
      { name: "Demo Bathrooms", metaAdAccountIds: "act_3001", ghlLocationId: "loc_bathrooms", industry: "Bathrooms", retainerExVat: 406.5, vat: "inc", billingMethod: "invoice", cplTarget: 15, contactName: "John", email: "john@example.com", startDate: "2026-05-01", reportRules: "Do NOT list leads. Give totals only." },
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

  await db.insert(schema.healthChecks).values([
    { clientId: clients[0].id, weekOf: weekStart(), status: "yellow", cpl: 18.4, leads: 21, spend: 386, issue: "Creative Fatigue", reason: "CPL €18.40 vs €15 target; frequency 3.4.", actionNeeded: "Launch 5 new static ads this week." },
    { clientId: clients[1].id, weekOf: weekStart(), status: "green", cpl: 8.9, leads: 44, spend: 392, issue: "Everything Healthy", reason: "CPL €8.90 vs €10 target." },
    { clientId: clients[2].id, weekOf: weekStart(), status: "red", cpl: 31, leads: 6, spend: 186, issue: "Leads Not Worked", reason: "5 of 6 leads untouched in GHL after 3 days.", actionNeeded: "Call John today and go through each lead." },
  ]);

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

  console.log(`Seeded ${clients.length} demo clients.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
