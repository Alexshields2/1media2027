import { createHmac, timingSafeEqual } from "node:crypto";

// Jarvis in Slack: the logic behind app/api/slack/route.ts, kept free of Next.js and the
// database so it can be tested with fakes. The route wires in the real dependencies.
//
// - Slash command  /jarvis <question>  → answered by the read-only Jarvis agent, posted later via response_url.
// - Buttons on approval notifications  → approve (runs through executeApproval and its guardrails) or reject.
//
// Slack needs an HTTP answer within 3 seconds, so the handler acknowledges straight away and
// does the slow work in `defer` (Next's after() on Vercel).

/** Slack rejects requests older than this; we do the same to stop replays. */
export const MAX_AGE_SECONDS = 60 * 5;

export const ACTION_APPROVE = "approval_approve";
export const ACTION_REJECT = "approval_reject";

// ---------- signatures ----------

export function signSlackRequest(signingSecret: string, timestamp: string | number, body: string): string {
  return "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Checks X-Slack-Signature against the raw body (https://api.slack.com/authentication/verifying-requests-from-slack). */
export function verifySlackSignature(opts: {
  signingSecret: string | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  nowSeconds?: number;
}): VerifyResult {
  const { signingSecret, timestamp, signature, body } = opts;
  if (!signingSecret) return { ok: false, reason: "SLACK_SIGNING_SECRET is not set" };
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) return { ok: false, reason: "stale timestamp" };
  const expected = Buffer.from(signSlackRequest(signingSecret, timestamp, body));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

// ---------- formatting ----------

/** Markdown from the agents → Slack mrkdwn (bold, headings, links). */
export function toSlackMrkdwn(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface ApprovalForSlack {
  id: number;
  agent: string;
  tool: string;
  input: Record<string, unknown>;
  label: string;
}

/** The text an approver needs to see: the message body if there is one, else the input. */
function approvalPreview(a: ApprovalForSlack): string {
  const i = a.input;
  const body = [i.body, i.message_body, i.text, i.message].find((v) => typeof v === "string") as string | undefined;
  if (body) return clip(body, 600);
  return clip(JSON.stringify(i), 400);
}

/** Block Kit for a finished run: summary, then each pending approval with Approve / Reject buttons. */
export function approvalBlocks(opts: { title: string; summary?: string; approvals: ApprovalForSlack[]; appUrl?: string }): unknown[] {
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: clip(`*${opts.title}*${opts.summary ? `\n${toSlackMrkdwn(opts.summary)}` : ""}`, 2900) } }];
  const shown = opts.approvals.slice(0, 10);
  for (const a of shown) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: clip(`*${a.label}*  _(${a.agent} · ${a.tool} · #${a.id})_\n>${approvalPreview(a).replace(/\n/g, "\n>")}`, 2900) },
      },
      {
        type: "actions",
        block_id: `approval_${a.id}`,
        elements: [
          {
            type: "button",
            action_id: ACTION_APPROVE,
            value: String(a.id),
            style: "primary",
            text: { type: "plain_text", text: "Approve and run" },
            confirm: {
              title: { type: "plain_text", text: "Run this action?" },
              text: { type: "plain_text", text: clip(a.label, 280) },
              confirm: { type: "plain_text", text: "Approve" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
          { type: "button", action_id: ACTION_REJECT, value: String(a.id), style: "danger", text: { type: "plain_text", text: "Reject" } },
        ],
      },
    );
  }
  const more = opts.approvals.length - shown.length;
  if (more > 0 || opts.appUrl) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${more > 0 ? `${more} more waiting. ` : ""}${opts.appUrl ? `<${opts.appUrl}/approvals|Open Approvals in 1Media OS>` : ""}` }],
    });
  }
  return blocks;
}

// ---------- request handling ----------

export interface SlackDeps {
  signingSecret: string | undefined;
  /** Slack user IDs allowed to ask and approve. Empty = anyone in the workspace that signed the request. */
  allowedUserIds: string[];
  /** If set, only requests from this workspace are accepted. */
  teamId?: string;
  /** Runs the slow part after the 200 has gone back to Slack. */
  defer: (fn: () => Promise<void>) => void;
  /** Ask the read-only Jarvis agent. Returns the answer text and the run id. */
  askJarvis: (question: string, who: string) => Promise<{ text: string; runId?: number; ok: boolean }>;
  /** Atomically move a pending approval to "approved" so a double click can't run it twice. Null if it wasn't pending. */
  claimApproval: (id: number) => Promise<{ id: number; label: string } | null>;
  /** Runs an approval that has been claimed (src/lib/approvals.ts executeApproval: guardrails still apply). */
  executeApproval: (id: number) => Promise<{ ok: boolean; result: string }>;
  /** Atomically reject a pending approval. Null if it wasn't pending. */
  rejectApproval: (id: number) => Promise<{ id: number; label: string } | null>;
  /** POST a message to a Slack response_url. */
  postResponse: (url: string, message: Record<string, unknown>) => Promise<void>;
  appUrl?: string;
  nowSeconds?: number;
}

export interface SlackRequest {
  headers: { get(name: string): string | null };
  body: string;
}

export interface SlackResponse {
  status: number;
  json?: unknown;
}

const ephemeral = (text: string) => ({ response_type: "ephemeral", text });

export async function handleSlack(req: SlackRequest, deps: SlackDeps): Promise<SlackResponse> {
  const check = verifySlackSignature({
    signingSecret: deps.signingSecret,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    body: req.body,
    nowSeconds: deps.nowSeconds,
  });
  if (!check.ok) return { status: check.reason.startsWith("SLACK_SIGNING_SECRET") ? 503 : 401, json: { error: check.reason } };

  // Events API URL check (JSON body). Harmless to support; the app only needs commands and interactivity.
  if (req.body.startsWith("{")) {
    const evt = JSON.parse(req.body) as { type?: string; challenge?: string };
    if (evt.type === "url_verification") return { status: 200, json: { challenge: evt.challenge } };
    return { status: 200 };
  }

  const form = new URLSearchParams(req.body);
  if (form.get("ssl_check")) return { status: 200 };

  const payloadRaw = form.get("payload");
  if (payloadRaw) return handleInteraction(JSON.parse(payloadRaw), deps);
  if (form.get("command")) return handleCommand(form, deps);
  return { status: 400, json: { error: "unsupported request" } };
}

function allowed(deps: SlackDeps, userId: string | undefined, teamId: string | undefined): string | null {
  if (deps.teamId && teamId !== deps.teamId) return "This Slack workspace isn't connected to 1Media OS.";
  if (deps.allowedUserIds.length && (!userId || !deps.allowedUserIds.includes(userId))) return "You're not on the 1Media OS list for Jarvis. Ask Alex to add your Slack user ID.";
  return null;
}

async function handleCommand(form: URLSearchParams, deps: SlackDeps): Promise<SlackResponse> {
  const question = (form.get("text") ?? "").trim();
  const userId = form.get("user_id") ?? undefined;
  const who = form.get("user_name") ?? userId ?? "someone";
  const responseUrl = form.get("response_url");
  const denied = allowed(deps, userId, form.get("team_id") ?? undefined);
  if (denied) return { status: 200, json: ephemeral(denied) };
  if (!question || question === "help") {
    return { status: 200, json: ephemeral("Ask Jarvis anything about the agency, e.g. `/jarvis who owes us money?` or `/jarvis how is Demo Paving doing this week?` Jarvis is read-only.") };
  }
  if (!responseUrl) return { status: 400, json: { error: "missing response_url" } };

  deps.defer(async () => {
    let message: Record<string, unknown>;
    try {
      const answer = await deps.askJarvis(question, who);
      const link = deps.appUrl && answer.runId ? `\n<${deps.appUrl}/agents/runs/${answer.runId}|See the run>` : "";
      const lead = answer.ok ? "" : "Jarvis couldn't finish: ";
      message = { response_type: "ephemeral", replace_original: false, text: clip(`*Q:* ${question}\n\n${lead}${toSlackMrkdwn(answer.text)}${link}`, 39000) };
    } catch (err) {
      message = ephemeral(`Jarvis couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    await deps.postResponse(responseUrl, message);
  });
  return { status: 200, json: ephemeral(`Thinking about: _${clip(question, 200)}_ …`) };
}

interface BlockActionsPayload {
  type: string;
  user?: { id?: string; username?: string; name?: string };
  team?: { id?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
}

async function handleInteraction(p: BlockActionsPayload, deps: SlackDeps): Promise<SlackResponse> {
  if (p.type !== "block_actions") return { status: 200 };
  const action = p.actions?.[0];
  const id = Number(action?.value);
  const responseUrl = p.response_url;
  if (!action || !Number.isInteger(id) || id <= 0 || !responseUrl) return { status: 200 };
  if (action.action_id !== ACTION_APPROVE && action.action_id !== ACTION_REJECT) return { status: 200 };

  const who = p.user?.username ?? p.user?.name ?? p.user?.id ?? "someone";
  const denied = allowed(deps, p.user?.id, p.team?.id);
  if (denied) {
    deps.defer(() => deps.postResponse(responseUrl, { response_type: "ephemeral", replace_original: false, text: denied }));
    return { status: 200 };
  }

  // Reply on the same message thread without replacing the notification (it may hold other approvals).
  const say = (text: string) => deps.postResponse(responseUrl, { response_type: "in_channel", replace_original: false, text });

  deps.defer(async () => {
    try {
      if (action.action_id === ACTION_REJECT) {
        const r = await deps.rejectApproval(id);
        await say(r ? `:x: Rejected by ${who}: ${r.label} (#${id})` : `#${id} was already decided; nothing changed.`);
        return;
      }
      const claimed = await deps.claimApproval(id);
      if (!claimed) {
        await say(`#${id} was already decided; nothing ran.`);
        return;
      }
      const res = await deps.executeApproval(id);
      await say(res.ok ? `:white_check_mark: Approved by ${who} and done: ${claimed.label} (#${id})` : `:warning: Approved by ${who} but it didn't run: ${claimed.label} (#${id}). ${clip(res.result, 500)}`);
    } catch (err) {
      await say(`:warning: #${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { status: 200 };
}
