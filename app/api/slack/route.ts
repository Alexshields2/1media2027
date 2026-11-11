import { NextResponse, after, type NextRequest } from "next/server";
import { AGENTS } from "@/agents/registry";
import { runAgent } from "@/lib/runner";
import { claimApproval, describeAction, executeApproval, rejectIfPending } from "@/lib/approvals";
import { appUrl } from "@/lib/slack";
import { handleSlack } from "@/lib/slack-app";

// Slack app endpoint for Jarvis: the /jarvis slash command and the Approve / Reject buttons on
// approval notifications. Every request is checked against SLACK_SIGNING_SECRET.
// Slack wants an answer within 3 seconds: we acknowledge at once and do the work in after().

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Slack's response URLs live on hooks.slack.com; refuse anything else unless testing locally. */
function safeResponseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && u.hostname === "hooks.slack.com") return true;
    return process.env.SLACK_ALLOW_LOCAL_RESPONSE_URL === "true" && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await handleSlack(
    { headers: req.headers, body },
    {
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      allowedUserIds: list(process.env.SLACK_ALLOWED_USER_IDS),
      teamId: process.env.SLACK_TEAM_ID || undefined,
      appUrl: appUrl(),
      defer: (fn) => after(() => fn().catch((e) => console.error("slack:", e))),
      askJarvis: async (question, who) => {
        // Jarvis is L0 (read-only); dryRun forces L0 as well, belt and braces.
        const run = await runAgent(AGENTS.jarvis, { instruction: `${question}\n\n(Asked in Slack by ${who}. Keep the answer short enough for a Slack message.)`, trigger: "webhook", dryRun: true });
        return { text: run.summary ?? "(no answer)", runId: run.id, ok: run.status === "completed" };
      },
      claimApproval: async (id) => {
        const a = await claimApproval(id);
        return a && { id: a.id, label: describeAction(a.tool, a.input) };
      },
      executeApproval,
      rejectApproval: async (id) => {
        const a = await rejectIfPending(id);
        return a && { id: a.id, label: describeAction(a.tool, a.input) };
      },
      postResponse: async (url, message) => {
        if (!safeResponseUrl(url)) throw new Error(`refusing response_url ${url}`);
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
        if (!r.ok) console.error("slack response_url:", r.status, await r.text());
      },
    },
  );
  return res.json === undefined ? new NextResponse(null, { status: res.status }) : NextResponse.json(res.json, { status: res.status });
}
