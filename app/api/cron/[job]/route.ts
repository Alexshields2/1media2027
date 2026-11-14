import { NextResponse, type NextRequest } from "next/server";
import { AGENTS } from "@/agents/registry";
import { modelReady, runAgent } from "@/lib/runner";
import { generateMonth } from "@/lib/billing";
import { monthStart } from "@/lib/dates";
import { notify } from "@/lib/slack";
import { appOrigin, dispatchJobs, enqueueReportJobs, sweepReportJobs } from "@/lib/report-jobs";
import { runRevolutSync } from "@/lib/revolut/run";

// Vercel Cron calls GET /api/cron/<job> with "Authorization: Bearer $CRON_SECRET".
// Jobs: any agent name, "billing" (creates this month's retainer rows; no AI), or "revolut-sync"
// (pulls Revolut Business transactions into Expenses and unmatched payments; no agent).
// weekly-report and month-end-report fan out: one job and one function per client
// (see src/lib/report-jobs.ts), so a slow account can't time out the others.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REPORT_JOBS: Record<string, "weekly" | "monthly"> = { "weekly-report": "weekly", "month-end-report": "monthly" };

export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { job } = await params;
  // Not an agent, so AGENTS_PAUSED doesn't stop it.
  if (job === "revolut-sync") return NextResponse.json({ job, ...(await runRevolutSync("cron")) });

  if (process.env.AGENTS_PAUSED === "true") {
    return NextResponse.json({ skipped: "AGENTS_PAUSED is true" });
  }

  const origin = appOrigin(req.nextUrl.origin);

  // Every cron also recovers report jobs whose function died, and re-sends any left in the queue.
  // On Hobby (daily crons) this is the retry safety net for the Monday and month-end fan-outs.
  const sweep = await sweepReportJobs().catch((e) => {
    console.error("report sweep failed", e);
    return null;
  });
  if (sweep?.pending.length) await dispatchJobs(origin, sweep.pending);

  if (job === "billing") {
    const created = await generateMonth(monthStart());
    if (created) await notify(`Billing: created ${created} retainer row(s) for this month.`);
    return NextResponse.json({ job, created });
  }

  // Without a model every agent run would just fail and fill the inbox with red "run failed" items.
  if (!modelReady()) return NextResponse.json({ job, skipped: "ANTHROPIC_API_KEY is not set" });

  const kind = REPORT_JOBS[job];
  if (kind) {
    const { period, queued, total } = await enqueueReportJobs(kind);
    const { sent, failed } = await dispatchJobs(origin, queued.map((j) => j.id));
    return NextResponse.json({ job, period: period.period, clients: total, dispatched: sent.length, dispatchFailed: failed.length });
  }

  const agent = AGENTS[job];
  if (!agent || agent.needsInstruction) {
    return NextResponse.json({ error: `unknown job ${job}` }, { status: 404 });
  }
  const run = await runAgent(agent, { trigger: "cron" });
  return NextResponse.json({ job, runId: run.id, status: run.status, proposed: run.proposed });
}
