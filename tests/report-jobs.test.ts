import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// End-to-end tests of the per-client reporting loop against a real Postgres, with the model,
// Meta Ads and GoHighLevel mocked by fixtures. They need a throwaway database:
//   TEST_DATABASE_URL=postgres://postgres@localhost:5433/onemedia_test npm test
// Every table in that database is emptied. Without TEST_DATABASE_URL these tests are skipped.

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set";

type Mods = {
  db: typeof import("../src/db");
  jobs: typeof import("../src/lib/report-jobs");
  mock: typeof import("../src/lib/mock-agents");
  metrics: typeof import("../src/lib/report-metrics");
  fx: typeof import("../src/lib/fixtures/ads-fixtures");
};
let m: Mods;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = url;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; // proves nothing calls the real model
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  await sql.end();
  m = {
    db: await import("../src/db"),
    jobs: await import("../src/lib/report-jobs"),
    mock: await import("../src/lib/mock-agents"),
    metrics: await import("../src/lib/report-metrics"),
    fx: await import("../src/lib/fixtures/ads-fixtures"),
  };
});

after(async () => {
  if (!skip) await m.db.closeDb();
});

const WEEK = "2026-11-02"; // Mon 2 – Sun 8 Nov 2026

async function reset() {
  const { db } = m.db;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE clients, payments, tasks, health_checks, reports, report_jobs, agent_runs, approvals RESTART IDENTITY CASCADE`);
  const { schema } = m.db;
  return db
    .insert(schema.clients)
    .values([
      { name: "Paving Co", metaAdAccountIds: "act_1001", ghlLocationId: "loc_paving", cplTarget: 15, driveFolderId: "drive_paving" },
      { name: "Attics Ltd", metaAdAccountIds: "act_2001, act_2002", ghlLocationId: "loc_attics", reportGreeting: "Hi Mary" },
      { name: "Bathrooms", metaAdAccountIds: "act_3001", reportRules: "Do NOT list leads. Give totals only." },
      { name: "New Client (no ads yet)" },
      { name: "Paused Co", status: "paused", metaAdAccountIds: "act_9" },
    ])
    .returning();
}

beforeEach(async () => {
  if (!skip) await reset();
});

const deps = (fail?: (name: string, input: Record<string, unknown>) => string | undefined) => ({ model: m.mock.scriptedModel(), external: m.mock.fixtureTools({ fail }) });

function expectedWeek(accounts: string[]) {
  const rows = accounts.flatMap((a) => m.fx.metaInsights(a, WEEK, "2026-11-08").data);
  return m.metrics.deriveMetrics({
    spend: rows.reduce((n, r) => n + Number(r.spend), 0),
    leads: m.fx.metaLeadCount(rows),
    impressions: rows.reduce((n, r) => n + Number(r.impressions), 0),
    clicks: rows.reduce((n, r) => n + Number(r.inline_link_clicks), 0),
  });
}

test("mocked Monday run: one job per active client, a report with numbers for each", { skip }, async () => {
  const { db, schema } = m.db;
  const period = m.metrics.weekPeriod(WEEK);
  const { queued, total } = await m.jobs.enqueueReportJobs("weekly", period);
  assert.equal(total, 4, "paused clients are left out");
  assert.equal(queued.length, 3, "the client without an ad account is skipped, not queued");

  // enqueue is idempotent: a second cron call creates nothing new
  await m.jobs.enqueueReportJobs("weekly", period);
  assert.equal((await db.select().from(schema.reportJobs)).length, 4);

  const jobs = await m.jobs.drainJobs("weekly", WEEK, { deps: deps() });
  const byStatus = Object.groupBy(jobs, (j) => j.status);
  assert.equal(byStatus.done?.length, 3);
  assert.equal(byStatus.skipped?.length, 1);
  assert.match(byStatus.skipped![0].lastError!, /No Meta ad account/);

  const reports = await db.select().from(schema.reports);
  assert.equal(reports.length, 3);
  const clients = await db.select().from(schema.clients);
  for (const r of reports) {
    const c = clients.find((x) => x.id === r.clientId)!;
    const exp = expectedWeek(m.mock.splitIds(c.metaAdAccountIds));
    assert.equal(r.kind, "weekly");
    assert.equal(r.period, WEEK);
    assert.equal(r.periodStart, WEEK);
    assert.equal(r.periodEnd, "2026-11-08");
    assert.deepEqual({ spend: r.spend, leads: r.leads, cpl: r.cpl, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr }, exp, `${c.name} numbers match the Meta fixtures`);
    assert.ok(r.runId, "report links to its agent run");
    assert.match(r.body, new RegExp(`Leads: ${exp.leads}`));
    assert.equal(r.status, "draft");
  }
  const attics = reports.find((r) => r.clientId === clients.find((c) => c.name === "Attics Ltd")!.id)!;
  assert.match(attics.body, /^Hi Mary, this is how/, "client greeting used");
  assert.match(attics.body, /Here are your leads/);
  const bath = reports.find((r) => r.clientId === clients.find((c) => c.name === "Bathrooms")!.id)!;
  assert.doesNotMatch(bath.body, /Here are your leads/, "report rules respected");

  // one agent run per client, each its own row
  assert.equal((await db.select().from(schema.agentRuns)).length, 3);
});

test("a failing account retries automatically and succeeds on a later attempt", { skip }, async () => {
  const { db, schema } = m.db;
  await m.jobs.enqueueReportJobs("weekly", m.metrics.weekPeriod(WEEK));
  let paving = 0;
  const jobs = await m.jobs.drainJobs("weekly", WEEK, {
    deps: deps((name, input) => (name === "METAADS_GET_INSIGHTS" && input.ad_account_id === "act_1001" && ++paving <= 2 ? "Meta Ads: (#17) User request limit reached" : undefined)),
  });
  const [c] = await db.select().from(schema.clients).where((await import("drizzle-orm")).eq(schema.clients.name, "Paving Co"));
  const job = jobs.find((j) => j.clientId === c.id)!;
  assert.equal(job.status, "done");
  assert.equal(job.attempts, 3);
  assert.equal(jobs.filter((j) => j.status === "done").length, 3, "the other clients weren't held up");
});

test("a client that keeps failing ends as failed, then a manual retry fixes it", { skip }, async () => {
  const { db, schema } = m.db;
  const { eq } = await import("drizzle-orm");
  await db.update(schema.clients).set({ metaAdAccountIds: "act_error" }).where(eq(schema.clients.name, "Bathrooms"));
  await m.jobs.enqueueReportJobs("weekly", m.metrics.weekPeriod(WEEK));
  const redispatched: number[] = [];
  let jobs = await m.jobs.drainJobs("weekly", WEEK, { deps: deps(), redispatch: async (id) => void redispatched.push(id) });
  const [bath] = await db.select().from(schema.clients).where(eq(schema.clients.name, "Bathrooms"));
  let job = jobs.find((j) => j.clientId === bath.id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 3);
  assert.match(job.lastError!, /limit reached/);
  assert.equal(redispatched.filter((id) => id === job.id).length, 2, "re-dispatched after attempts 1 and 2");
  assert.equal(jobs.filter((j) => j.status === "done").length, 2);
  assert.equal((await db.select().from(schema.reports).where(eq(schema.reports.clientId, bath.id))).length, 0);

  // Fix the account, press Retry
  await db.update(schema.clients).set({ metaAdAccountIds: "act_3001" }).where(eq(schema.clients.id, bath.id));
  const reset = await m.jobs.resetJob(job.id);
  assert.equal(reset?.status, "queued");
  assert.equal(reset?.attempts, 0);
  job = (await m.jobs.processJob(job.id, { deps: deps() }))!;
  assert.equal(job.status, "done");
  const [r] = await db.select().from(schema.reports).where(eq(schema.reports.clientId, bath.id));
  assert.ok(r.spend! > 0 && r.leads! > 0);
});

test("a job is claimed once; a worker killed by the time limit is recovered by the sweep", { skip }, async () => {
  const { queued } = await m.jobs.enqueueReportJobs("weekly", m.metrics.weekPeriod(WEEK));
  const id = queued[0].id;
  const t0 = Date.now();
  const claimed = await m.jobs.claimJob(id, t0);
  assert.equal(claimed?.status, "running");
  assert.equal(await m.jobs.claimJob(id, t0 + 1000), null, "second worker can't take a running job");

  // Not dead yet
  let sweep = await m.jobs.sweepReportJobs(t0 + 60_000);
  assert.equal(sweep.recovered, 0);

  // Function killed at 300 s: the lock expires and the sweep requeues it
  sweep = await m.jobs.sweepReportJobs(t0 + m.jobs.JOB_LOCK_MS + 1000);
  assert.equal(sweep.recovered, 1);
  const later = t0 + m.jobs.JOB_LOCK_MS + 1000 + 5 * 60_000;
  sweep = await m.jobs.sweepReportJobs(later);
  assert.ok(sweep.pending.includes(id), "requeued job is offered for dispatch on the next sweep");
  const done = await m.jobs.processJob(id, { deps: deps() });
  assert.equal(done?.status, "done");
  assert.equal(done?.attempts, 2);
});

test("a sent report is never overwritten by a re-run", { skip }, async () => {
  const { db, schema } = m.db;
  const { eq } = await import("drizzle-orm");
  await m.jobs.enqueueReportJobs("weekly", m.metrics.weekPeriod(WEEK));
  await m.jobs.drainJobs("weekly", WEEK, { deps: deps() });
  const [r] = await db.select().from(schema.reports).limit(1);
  await db.update(schema.reports).set({ status: "sent", body: "SENT VERSION – do not touch" }).where(eq(schema.reports.id, r.id));
  const [job] = await db.select().from(schema.reportJobs).where(eq(schema.reportJobs.clientId, r.clientId));
  await db.update(schema.reportJobs).set({ status: "failed" }).where(eq(schema.reportJobs.id, job.id));
  await m.jobs.resetJob(job.id);
  const again = await m.jobs.processJob(job.id, { deps: deps() });
  assert.equal(again?.status, "done");
  const [after] = await db.select().from(schema.reports).where(eq(schema.reports.id, r.id));
  assert.equal(after.body, "SENT VERSION – do not touch");
  assert.equal((await db.select().from(schema.reports).where(eq(schema.reports.clientId, r.clientId))).length, 1);
});

test("month-end: totals from the weekly data, PDF saved to the client's Drive folder", { skip }, async () => {
  const { db, schema } = m.db;
  const { eq } = await import("drizzle-orm");
  // Four October weeks of weekly reports
  for (const wk of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) {
    await m.jobs.enqueueReportJobs("weekly", m.metrics.weekPeriod(wk));
    await m.jobs.drainJobs("weekly", wk, { deps: deps() });
  }
  const uploads: { tool: string; arguments: Record<string, unknown> }[] = [];
  await m.jobs.enqueueReportJobs("monthly", m.metrics.monthPeriod("2026-10"));
  const jobs = await m.jobs.drainJobs("monthly", "2026-10", {
    deps: deps(),
    uploader: async (call) => {
      uploads.push(call);
      return { successful: true, data: { id: "file_1", webViewLink: "https://drive.google.com/file/d/file_1/view" } };
    },
  });
  // Every active client gets a month-end job; the one with no weekly data is skipped (nothing to report)
  const clients = await db.select().from(schema.clients);
  const name = (id: number) => clients.find((c) => c.id === id)!.name;
  assert.deepEqual(jobs.map((j) => [name(j.clientId), j.status]).sort(), [
    ["Attics Ltd", "done"],
    ["Bathrooms", "done"],
    ["New Client (no ads yet)", "skipped"],
    ["Paving Co", "done"],
  ]);

  const monthly = await db.select().from(schema.reports).where(eq(schema.reports.kind, "monthly"));
  assert.equal(monthly.length, 3);
  for (const r of monthly) {
    const weeks = await m.jobs.weeklyReportsForMonth(r.clientId, "2026-10");
    assert.equal(weeks.length, 4);
    const t = m.metrics.sumMetrics(weeks);
    assert.deepEqual({ spend: r.spend, leads: r.leads, cpl: r.cpl, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr }, t, `${name(r.clientId)} month = sum of weeks`);
    assert.equal(r.periodStart, "2026-10-01");
    assert.equal(r.periodEnd, "2026-10-31");
  }
  // Only Paving Co has a Drive folder
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].arguments.folder_to_upload_to, "drive_paving");
  const paving = monthly.find((r) => name(r.clientId) === "Paving Co")!;
  assert.equal(paving.driveUrl, "https://drive.google.com/file/d/file_1/view");
  const attics = monthly.find((r) => name(r.clientId) === "Attics Ltd")!;
  assert.equal(attics.driveUrl, null);
  assert.match(attics.driveError ?? "", /No Drive folder/);
});

test("fan-out sends one authenticated worker request per job", { skip }, async () => {
  const hits: { auth?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ auth: req.headers.authorization, body });
      res.statusCode = body.includes('"jobId":3') ? 409 : 202; // 409 = already taken, still fine
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  process.env.CRON_SECRET = "test-secret";
  try {
    const out = await m.jobs.dispatchJobs(`http://127.0.0.1:${port}`, [1, 2, 3]);
    assert.deepEqual(out, { sent: [1, 2, 3], failed: [] });
    assert.equal(hits.length, 3);
    assert.ok(hits.every((h) => h.auth === "Bearer test-secret"));
    const down = await m.jobs.dispatchJobs("http://127.0.0.1:1", [7]);
    assert.deepEqual(down, { sent: [], failed: [7] });
  } finally {
    server.close();
    delete process.env.CRON_SECRET;
  }
});
