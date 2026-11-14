import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { and, eq, inArray, isNotNull, or, ne, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { AGENTS } from "@/agents/registry";
import { runAgent } from "@/lib/runner";
import { generateMonth } from "@/lib/billing";
import { monthStart, today } from "@/lib/dates";
import { notify } from "@/lib/slack";
import { isDue } from "@/lib/sops";
import { logActivity, asSystem } from "@/lib/activity";
import { authorized, runSopTarget, sopBaseUrl } from "../shared";

// Vercel Cron calls GET /api/cron/<job> with "Authorization: Bearer $CRON_SECRET".
// Jobs: any (non-hidden) agent name, plus:
//   billing       creates this month's retainer rows (no AI)
//   sops          starts every library SOP whose agent schedule is due today
//   eod-reminder  pings Slack about anyone who hasn't sent an end-of-day report

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.AGENTS_PAUSED === "true") return NextResponse.json({ skipped: "AGENTS_PAUSED is true" });

  const { job } = await params;

  if (job === "billing") {
    const created = await generateMonth(monthStart());
    if (created) await notify(`Billing: created ${created} retainer row(s) for this month.`);
    await logActivity(asSystem("billing"), { action: "payments.generated", summary: `Created ${created} retainer row(s) for ${monthStart().slice(0, 7)}` });
    return NextResponse.json({ job, created });
  }

  if (job === "sops") return dispatchSops(req);
  if (job === "eod-reminder") return eodReminder();

  const agent = AGENTS[job];
  if (!agent || agent.needsInstruction || agent.hidden) {
    return NextResponse.json({ error: `unknown job ${job}` }, { status: 404 });
  }
  const run = await runAgent(agent, { trigger: "cron" });
  return NextResponse.json({ job, runId: run.id, status: run.status, proposed: run.proposed });
}

/** Starts each due SOP (once per client for per-client SOPs), each in its own function call. */
async function dispatchSops(req: NextRequest) {
  const date = today();
  const candidates = await db
    .select()
    .from(schema.sops)
    .where(and(eq(schema.sops.agentEnabled, true), eq(schema.sops.archived, false), ne(schema.sops.schedule, "manual")));
  const due = candidates.filter((s) => isDue(s, date));
  const started: { sop: number; client: number | null; how: string }[] = [];

  for (const s of due) {
    // Claim today's run first, so an overlapping cron call can't start it twice.
    const claimed = await db
      .update(schema.sops)
      .set({ lastRunDate: date })
      .where(and(eq(schema.sops.id, s.id), or(isNull(schema.sops.lastRunDate), ne(schema.sops.lastRunDate, date))))
      .returning({ id: schema.sops.id });
    if (!claimed.length) continue;

    const clients = s.perClient
      ? await db.select({ id: schema.clients.id }).from(schema.clients).where(inArray(schema.clients.status, ["active", "onboarding"]))
      : [null];
    for (const c of clients) {
      const how = await startElsewhere(req, s.id, c?.id ?? null);
      if (how === "inline") after(() => runSopTarget(s.id, c?.id ?? null).catch((e) => console.error(e)));
      started.push({ sop: s.id, client: c?.id ?? null, how });
    }
    await logActivity(asSystem("scheduler"), { action: "sop.scheduled", summary: `Started SOP "${s.title}"${s.perClient ? ` for ${clients.length} client(s)` : ""}`, entity: "sop", entityId: s.id });
  }
  return NextResponse.json({ job: "sops", date, due: due.length, started });
}

/** Calls /api/cron/sop/<id> so each run gets its own 300-second budget. Falls back to running here. */
async function startElsewhere(req: NextRequest, sopId: number, clientId: number | null): Promise<"fanout" | "inline"> {
  const url = new URL(`/api/cron/sop/${sopId}`, sopBaseUrl(req));
  if (clientId) url.searchParams.set("client", String(clientId));
  const headers: Record<string, string> = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    return res.ok ? "fanout" : "inline";
  } catch {
    return "inline";
  }
}

/** Everyone who reports to someone should send an EOD on weekdays. */
async function eodReminder() {
  const date = today();
  const team = await db.select().from(schema.users).where(and(eq(schema.users.active, true), isNotNull(schema.users.managerId)));
  const sent = await db.select({ userId: schema.eodReports.userId }).from(schema.eodReports).where(eq(schema.eodReports.date, date));
  const missing = team.filter((u) => !sent.some((s) => s.userId === u.id));
  if (missing.length) {
    await notify(`End-of-day reports still to come today: ${missing.map((u) => u.name).join(", ")}. Add yours in 1Media OS → End of day.`);
    await logActivity(asSystem("scheduler"), { action: "eod.reminder", summary: `Reminded ${missing.map((u) => u.name).join(", ")} to send an end-of-day report` });
  }
  return NextResponse.json({ job: "eod-reminder", date, missing: missing.map((u) => u.name) });
}
