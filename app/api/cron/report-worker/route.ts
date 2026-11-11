import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { appOrigin, claimJob, dispatchJobs, executeJob } from "@/lib/report-jobs";

// Runs ONE client's report job in its own function (own 300 s budget).
// Called by the weekly / month-end cron fan-out with the CRON_SECRET bearer token.
// Claims the job, answers 202 straight away, then writes the report in after().

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ jobId: z.coerce.number().int().positive(), trigger: z.enum(["cron", "manual"]).optional() });

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const { jobId, trigger = "cron" } = parsed.data;

  const job = await claimJob(jobId);
  if (!job) return NextResponse.json({ jobId, skipped: "not queued (already running or finished)" }, { status: 409 });

  const origin = appOrigin(req.nextUrl.origin);
  after(async () => {
    try {
      // A failed attempt goes back in the queue; send it to a fresh function for the retry.
      await executeJob(job, { trigger, redispatch: async (id) => void (await dispatchJobs(origin, [id], trigger)) });
    } catch (e) {
      console.error(`report job ${jobId} crashed`, e);
    }
  });
  return NextResponse.json({ jobId, status: "running", attempt: job.attempts }, { status: 202 });
}
