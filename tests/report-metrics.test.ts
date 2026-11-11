import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMetrics, sumMetrics, hasCoreNumbers, pctChange, reportWeek, reportMonth, weekPeriod, monthPeriod, shiftWeek, toWhatsApp } from "../src/lib/report-metrics";
import { metaInsights, ghlContacts, metaLeadCount } from "../src/lib/fixtures/ads-fixtures";

test("CPL and CTR are computed from the base numbers, not trusted from the model", () => {
  assert.deepEqual(deriveMetrics({ spend: 392, leads: 44, impressions: 41220, clicks: 612, cpl: 99, ctr: 99 }), {
    spend: 392,
    leads: 44,
    cpl: 8.91,
    impressions: 41220,
    clicks: 612,
    ctr: 1.48,
  });
  // zero leads: no CPL rather than Infinity
  assert.equal(deriveMetrics({ spend: 50, leads: 0 }).cpl, null);
  // only CPL known: kept
  assert.equal(deriveMetrics({ cpl: 12.345 }).cpl, 12.35);
});

test("month totals sum weeks and recompute rates", () => {
  const t = sumMetrics([
    { spend: 100, leads: 10, impressions: 10000, clicks: 100 },
    { spend: 200, leads: 10, impressions: 10000, clicks: 300 },
    { spend: null, leads: null },
  ]);
  assert.deepEqual(t, { spend: 300, leads: 20, cpl: 15, impressions: 20000, clicks: 400, ctr: 2 });
  assert.equal(sumMetrics([]).spend, null);
  assert.ok(hasCoreNumbers({ spend: 0, leads: 0 }));
  assert.ok(!hasCoreNumbers({ spend: 10 }));
});

test("pctChange", () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(90, 100), -10);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctChange(null, 4), null);
});

test("report periods", () => {
  // Monday 9 Nov 2026 reports on Mon 2 – Sun 8 Nov
  assert.deepEqual(
    { ...reportWeek("2026-11-09"), label: undefined },
    { kind: "weekly", period: "2026-11-02", start: "2026-11-02", end: "2026-11-08", label: undefined },
  );
  // a manual run mid-week still reports the last full week
  assert.equal(reportWeek("2026-11-11").period, "2026-11-02");
  assert.equal(weekPeriod("2026-11-05").period, "2026-11-02");
  assert.equal(shiftWeek("2026-11-02", -1), "2026-10-26");
  assert.equal(reportMonth("2026-12-01").period, "2026-11");
  assert.equal(reportMonth("2027-01-01").period, "2026-12");
  assert.equal(monthPeriod("2026-02").end, "2026-02-28");
  assert.equal(monthPeriod("2026-10").label, "October 2026");
});

test("WhatsApp formatting", () => {
  const md = "# ACME\n\n## Executive Summary\nA **strong** month.\n\n\n\n- Leads: 40\n* Spend: €400";
  assert.equal(toWhatsApp(md), "*ACME*\n\n*Executive Summary*\nA *strong* month.\n\n• Leads: 40\n• Spend: €400");
  // weekly plain text passes through untouched
  const weekly = "Hi guys, this is how we got on last week.\n\nLeads: 12\nAmount spent: €200";
  assert.equal(toWhatsApp(weekly), weekly);
});

test("fixtures are deterministic and GHL matches Meta's lead count", () => {
  const a = metaInsights("act_1", "2026-11-02", "2026-11-08");
  const b = metaInsights("act_1", "2026-11-02", "2026-11-08");
  assert.deepEqual(a, b);
  const leads = metaLeadCount(a.data);
  assert.ok(leads > 0);
  assert.equal(ghlContacts("loc", "2026-11-02", "2026-11-08", leads).contacts.length, leads);
  assert.throws(() => metaInsights("act_error", "2026-11-02", "2026-11-08"), /limit reached/);
});
