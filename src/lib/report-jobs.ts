import { and, asc, desc, eq, inArray, lt, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import type { AgentRun, Client, Report, ReportJob } from "../db/schema";
import { weeklyReport } from "../agents/weekly-report";
import { monthEndReport } from "../agents/month-end-report";
import { runAgent, type RunDeps } from "./runner";
import { hasCoreNumbers, periodFor, reportMonth, reportWeek, sumMetrics, type Period } from "./report-metrics";
import { monthlyReportPdf, pdfFileName } from "./report-pdf";
import { uploadPdfToDrive, type DriveUploader } from "./drive";
import { notify } from "./slack";

// Per-client report jobs.
//
// Vercel Hobby runs a cron at most once a day and stops a function after 300 s, so one agent
// writing every client's report in one function doesn't fit. Instead:
//   1. The cron enqueues one report_jobs row per active client (idempotent per kind/period/client).
//   2. It fans out: one POST to /api/cron/report-worker per job. Each worker is its own function
//      with its own 300 s budget; it claims the job, answers 202 at once and runs the agent in after().
//   3. A failed attempt goes back to "queued" and the worker re-dispatches it, up to max_attempts.
//   4. A worker killed by the time limit leaves its job "running" with locked_until in the past.
//      sweepReportJobs() (called by every cron) puts those back in the queue or marks them failed,
//      and re-dispatches anything queued that nobody picked up.
//   5. The Reports page shows each client's status and a Retry button per client.

/** A running job whose lock is older than this is treated as dead (function limit is 300 s). */
export const JOB_LOCK_MS = 320_000;
/** The agent starts no new model turn after this, so it saves its run before the limit. */
export const JOB_BUDGET_MS = 240_000;
/** Queued jobs untouched for this long are picked up by the sweep. */
const SWEEP_QUEUED_AFTER_MS = 120_000;

export type ReportKind = ReportJob["kind"];

export interface JobOptions {
  trigger?: AgentRun["trigger"];
  deps?: RunDeps;
  uploader?: DriveUploader;
  /** Called when a failed attempt was put back in the queue (the worker re-dispatches it). */
  redispatch?: (jobId: number) => Promise<void>;
  now?: () => number;
}

export function currentPeriod(kind: ReportKind, d?: string): Period {
  return kind === "weekly" ? reportWeek(d) : reportMonth(d);
}

function skipReason(kind: ReportKind, c: Client): string | null {
  if (kind === "weekly" && !c.metaAdAccountIds?.trim()) return "No Meta ad account on the client record.";
  return null;
}

/** Creates one job per active client for the period (existing jobs are left alone). Returns the jobs ready to dispatch. */
export async function enqueueReportJobs(kind: ReportKind, period: Period = currentPeriod(kind)): Promise<{ period: Period; queued: ReportJob[]; total: number }> {
  const clients = await db.select().from(schema.clients).where(eq(schema.clients.status, "active")).orderBy(asc(schema.clients.name));
  if (clients.length) {
    await db
      .insert(schema.reportJobs)
      .values(
        clients.map((c) => {
          const reason = skipReason(kind, c);
          return { kind, period: period.period, clientId: c.id, status: reason ? ("skipped" as const) : ("queued" as const), lastError: reason };
        }),
      )
      .onConflictDoNothing();
  }
  const queued = await db
    .select()
    .from(schema.reportJobs)
    .where(and(eq(schema.reportJobs.kind, kind), eq(schema.reportJobs.period, period.period), eq(schema.reportJobs.status, "queued")));
  return { period, queued, total: clients.length };
}

/** Atomically takes a queued job (or a dead running one). Returns null if someone else has it or it's finished. */
export async function claimJob(id: number, now = Date.now()): Promise<ReportJob | null> {
  const [job] = await db
    .update(schema.reportJobs)
    .set({
      status: "running",
      attempts: dsql`${schema.reportJobs.attempts} + 1`,
      lockedUntil: new Date(now + JOB_LOCK_MS),
      startedAt: new Date(now),
      finishedAt: null,
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(schema.reportJobs.id, id),
        or(eq(schema.reportJobs.status, "queued"), and(eq(schema.reportJobs.status, "running"), lt(schema.reportJobs.lockedUntil, new Date(now)))),
      ),
    )
    .returning();
  return job ?? null;
}

async function latestReport(clientId: number, kind: ReportKind, period: string): Promise<Report | undefined> {
  const [r] = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.clientId, clientId), eq(schema.reports.kind, kind), eq(schema.reports.period, period)))
    .orderBy(desc(schema.reports.updatedAt))
    .limit(1);
  return r;
}

/** The client's weekly reports for weeks starting in the month, oldest first. */
export async function weeklyReportsForMonth(clientId: number, month: string): Promise<Report[]> {
  return db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.clientId, clientId), eq(schema.reports.kind, "weekly"), dsql`${schema.reports.period} like ${month + "%"}`))
    .orderBy(asc(schema.reports.period));
}

/** Builds the month-end PDF and, when configured, saves it to the client's Drive folder. Never throws. */
export async function publishMonthEndPdf(report: Report, client: Client, uploader?: DriveUploader): Promise<Report> {
  try {
    const weeks = await weeklyReportsForMonth(client.id, report.period);
    const bytes = await monthlyReportPdf({ client, report, weeks });
    const res = await uploadPdfToDrive({ folderId: client.driveFolderId, fileName: pdfFileName(client.name, "monthly", report.period), bytes }, uploader);
    const set =
      res.status === "uploaded"
        ? { driveFileId: res.fileId, driveUrl: res.url, driveError: null }
        : { driveError: res.status === "failed" ? `Drive upload failed: ${res.error}` : res.reason };
    const [saved] = await db.update(schema.reports).set(set).where(eq(schema.reports.id, report.id)).returning();
    return saved;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const [saved] = await db.update(schema.reports).set({ driveError: `PDF failed: ${msg}` }).where(eq(schema.reports.id, report.id)).returning();
    return saved;
  }
}

async function finish(job: ReportJob, set: Partial<ReportJob>): Promise<ReportJob> {
  const [saved] = await db
    .update(schema.reportJobs)
    .set({ ...set, lockedUntil: null, updatedAt: new Date() })
    .where(eq(schema.reportJobs.id, job.id))
    .returning();
  return saved;
}

/** Runs one claimed job: the agent for one client, then checks a report with numbers was saved. */
export async function executeJob(job: ReportJob, opts: JobOptions = {}): Promise<ReportJob> {
  const now = opts.now ?? Date.now;
  let runId: number | null = null;
  try {
    const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, job.clientId));
    if (!client) return finish(job, { status: "failed", lastError: "Client not found.", finishedAt: new Date() });
    const reason = skipReason(job.kind, client);
    if (reason) return finish(job, { status: "skipped", lastError: reason, finishedAt: new Date() });

    const existing = await latestReport(client.id, job.kind, job.period);
    if (existing?.status === "sent") {
      return finish(job, { status: "done", reportId: existing.id, lastError: null, finishedAt: new Date() });
    }

    if (job.kind === "monthly" && !(await weeklyReportsForMonth(client.id, job.period)).length) {
      return finish(job, { status: "skipped", lastError: "No weekly reports for this month, so there is nothing to sum up.", finishedAt: new Date() });
    }

    const period = periodFor(job.kind, job.period);
    const agent = job.kind === "weekly" ? weeklyReport : monthEndReport;
    const run = await runAgent(agent, {
      trigger: opts.trigger ?? "cron",
      client: { id: client.id, name: client.name },
      period,
      deadline: now() + JOB_BUDGET_MS,
      deps: opts.deps,
    });
    runId = run.id;

    let report = await latestReport(client.id, job.kind, job.period);
    const fresh = report && report.runId === run.id;
    let error: string | null = null;
    if (run.status !== "completed") error = run.summary ?? `Agent run ${run.status}.`;
    else if (!report || !fresh) error = `The agent finished without saving a report. ${run.summary ?? ""}`.trim();
    else if (job.kind === "weekly" && !hasCoreNumbers(report)) error = "The report was saved without spend and leads.";

    if (!error && report && job.kind === "monthly") {
      // Month-end numbers always come from the weekly data if the agent left them out.
      if (!hasCoreNumbers(report)) {
        const totals = sumMetrics(await weeklyReportsForMonth(client.id, job.period));
        [report] = await db.update(schema.reports).set(totals).where(eq(schema.reports.id, report.id)).returning();
      }
      await publishMonthEndPdf(report, client, opts.uploader);
    }

    if (!error) return finish(job, { status: "done", runId, reportId: report!.id, lastError: null, finishedAt: new Date() });
    return failAttempt(job, error.slice(0, 1000), runId, opts);
  } catch (err) {
    return failAttempt(job, err instanceof Error ? err.message : String(err), runId, opts);
  }
}

async function failAttempt(job: ReportJob, error: string, runId: number | null, opts: JobOptions): Promise<ReportJob> {
  const retry = job.attempts < job.maxAttempts;
  const saved = await finish(job, { status: retry ? "queued" : "failed", lastError: error, runId: runId ?? job.runId, finishedAt: retry ? null : new Date() });
  if (retry) {
    await opts.redispatch?.(job.id);
  } else {
    const [c] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, job.clientId));
    await notify(`Report failed: *${c?.name ?? job.clientId}* ${job.kind} ${job.period} after ${job.attempts} attempt(s).\n${error.slice(0, 500)}\nRetry it on the Reports page.`);
  }
  return saved;
}

/** Claims and runs one job. Returns null when the job wasn't claimable (already running or finished). */
export async function processJob(id: number, opts: JobOptions = {}): Promise<ReportJob | null> {
  const job = await claimJob(id, (opts.now ?? Date.now)());
  if (!job) return null;
  return executeJob(job, opts);
}

/** Runs every queued job for a period one after another, retrying failures in place. For the CLI and tests, not for Vercel. */
export async function drainJobs(kind: ReportKind, period: string, opts: JobOptions = {}): Promise<ReportJob[]> {
  for (let guard = 0; guard < 500; guard++) {
    const [next] = await db
      .select({ id: schema.reportJobs.id })
      .from(schema.reportJobs)
      .where(and(eq(schema.reportJobs.kind, kind), eq(schema.reportJobs.period, period), eq(schema.reportJobs.status, "queued")))
      .orderBy(asc(schema.reportJobs.id))
      .limit(1);
    if (!next) break;
    await processJob(next.id, opts);
  }
  return db.select().from(schema.reportJobs).where(and(eq(schema.reportJobs.kind, kind), eq(schema.reportJobs.period, period)));
}

/** Puts a failed or skipped job back in the queue with a fresh set of attempts. */
export async function resetJob(id: number): Promise<ReportJob | null> {
  const [job] = await db
    .update(schema.reportJobs)
    .set({ status: "queued", attempts: 0, lockedUntil: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.reportJobs.id, id), inArray(schema.reportJobs.status, ["failed", "skipped", "queued"])))
    .returning();
  return job ?? null;
}

/** Recovers jobs whose worker died and returns the ids of queued jobs nobody picked up. */
export async function sweepReportJobs(now = Date.now()): Promise<{ recovered: number; failed: number; pending: number[] }> {
  const dead = await db
    .select()
    .from(schema.reportJobs)
    .where(and(eq(schema.reportJobs.status, "running"), lt(schema.reportJobs.lockedUntil, new Date(now))));
  let recovered = 0;
  let failed = 0;
  for (const job of dead) {
    const retry = job.attempts < job.maxAttempts;
    // Only flip it if it's still the same dead attempt.
    const [r] = await db
      .update(schema.reportJobs)
      .set({ status: retry ? "queued" : "failed", lastError: "Timed out (the function hit its time limit).", lockedUntil: null, finishedAt: retry ? null : new Date(now), updatedAt: new Date(now) })
      .where(and(eq(schema.reportJobs.id, job.id), eq(schema.reportJobs.status, "running"), lt(schema.reportJobs.lockedUntil, new Date(now))))
      .returning({ id: schema.reportJobs.id });
    if (r) retry ? recovered++ : failed++;
  }
  const pending = await db
    .select({ id: schema.reportJobs.id })
    .from(schema.reportJobs)
    .where(and(eq(schema.reportJobs.status, "queued"), lt(schema.reportJobs.updatedAt, new Date(now - SWEEP_QUEUED_AFTER_MS))));
  return { recovered, failed, pending: pending.map((p) => p.id) };
}

// ---------- fan-out over HTTP ----------

/** Base URL of this deployment, for calling the worker route. */
export function appOrigin(fallback: string): string {
  return (process.env.APP_URL || fallback).replace(/\/$/, "");
}

/**
 * Sends one worker request per job. Each worker answers as soon as it has claimed its job, so
 * this returns in seconds while the reports are written in parallel, in separate functions.
 */
export async function dispatchJobs(origin: string, ids: number[], trigger: AgentRun["trigger"] = "cron"): Promise<{ sent: number[]; failed: number[] }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { sent: [], failed: ids };
  const results = await Promise.allSettled(
    ids.map(async (jobId) => {
      const res = await fetch(`${origin}/api/cron/report-worker`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ jobId, trigger }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok && res.status !== 409) throw new Error(`worker answered ${res.status}`);
      return jobId;
    }),
  );
  const sent: number[] = [];
  const failed: number[] = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? sent : failed).push(ids[i]));
  if (failed.length) console.error(`report fan-out: ${failed.length} dispatch(es) failed; the next cron sweep picks them up`);
  return { sent, failed };
}
