import { approvalBlocks, type ApprovalForSlack } from "./slack-app";

/** Base URL of the app for links in Slack messages. */
export function appUrl(): string | undefined {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return undefined;
}

async function post(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (err) {
    console.error("Slack notify failed:", err);
  }
}

/** Posts a message to Slack via an incoming webhook. No-op when SLACK_WEBHOOK_URL isn't set. */
export async function notify(text: string): Promise<void> {
  await post({ text });
}

/**
 * Run finished with actions waiting: the summary plus Approve / Reject buttons per action.
 * The buttons work when SLACK_WEBHOOK_URL belongs to the 1Media OS Slack app (interactivity → /api/slack).
 */
export async function notifyApprovals(opts: { title: string; summary?: string; approvals: ApprovalForSlack[] }): Promise<void> {
  const fallback = `${opts.title} – ${opts.approvals.length} action(s) waiting for approval.`;
  await post({ text: fallback, blocks: approvalBlocks({ ...opts, appUrl: appUrl() }) });
}
