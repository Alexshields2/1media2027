import { NextResponse, type NextRequest } from "next/server";
import { AGENTS } from "@/agents/registry";
import { runAgent } from "@/lib/runner";
import { generateMonth } from "@/lib/billing";
import { monthStart } from "@/lib/dates";
import { notify } from "@/lib/slack";

// Vercel Cron calls GET /api/cron/<job> with "Authorization: Bearer $CRON_SECRET".
// Jobs: any agent name, or "billing" (creates this month's retainer rows; no AI).

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (process.env.AGENTS_PAUSED === "true") {
    return NextResponse.json({ skipped: "AGENTS_PAUSED is true" });
  }

  const { job } = await params;

  if (job === "billing") {
    const created = await generateMonth(monthStart());
    if (created) await notify(`Billing: created ${created} retainer row(s) for this month.`);
    return NextResponse.json({ job, created });
  }

  const agent = AGENTS[job];
  if (!agent || agent.needsInstruction) {
    return NextResponse.json({ error: `unknown job ${job}` }, { status: 404 });
  }
  const run = await runAgent(agent, { trigger: "cron" });
  return NextResponse.json({ job, runId: run.id, status: run.status, proposed: run.proposed });
}
