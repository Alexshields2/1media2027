import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  approvalBlocks,
  handleSlack,
  signSlackRequest,
  toSlackMrkdwn,
  verifySlackSignature,
  type SlackDeps,
} from "../src/lib/slack-app";
import { decide } from "../src/lib/guardrails";
import { AGENTS } from "../src/agents/registry";
import { isExcluded } from "../src/lib/runner";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_794_400_000;

function signed(body: string, opts: { ts?: number; secret?: string } = {}) {
  const ts = String(opts.ts ?? NOW);
  const h = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlackRequest(opts.secret ?? SECRET, ts, body),
  });
  return { headers: h, body };
}

/** Fake dependencies: an in-memory approvals table and a recorder for everything posted back to Slack. */
function fakes(over: Partial<SlackDeps> = {}) {
  const approvals = new Map<number, { status: string; tool: string }>([
    [7, { status: "pending", tool: "GMAIL_REPLY_TO_THREAD" }],
    [8, { status: "pending", tool: "GOOGLEDRIVE_DELETE_FILE" }],
    [9, { status: "executed", tool: "GMAIL_REPLY_TO_THREAD" }],
  ]);
  const posted: { url: string; message: Record<string, unknown> }[] = [];
  const deferred: Promise<void>[] = [];
  const executed: number[] = [];
  const asked: string[] = [];
  const deps: SlackDeps = {
    signingSecret: SECRET,
    allowedUserIds: [],
    nowSeconds: NOW,
    appUrl: "https://os.example",
    defer: (fn) => void deferred.push(fn()),
    askJarvis: async (q) => {
      asked.push(q);
      return { text: "**£0 outstanding.** Everyone has paid.", runId: 42, ok: true };
    },
    claimApproval: async (id) => {
      const a = approvals.get(id);
      if (!a || a.status !== "pending") return null;
      a.status = "approved";
      return { id, label: `reply to thread #${id}` };
    },
    executeApproval: async (id) => {
      executed.push(id);
      const a = approvals.get(id)!;
      // Same rule as the real executeApproval: hard blocks stay blocked even when approved.
      const d = decide(a.tool, "L3");
      if (d.action === "block") {
        a.status = "failed";
        return { ok: false, result: d.reason };
      }
      a.status = "executed";
      return { ok: true, result: "{}" };
    },
    rejectApproval: async (id) => {
      const a = approvals.get(id);
      if (!a || a.status !== "pending") return null;
      a.status = "rejected";
      return { id, label: `reply to thread #${id}` };
    },
    postResponse: async (url, message) => void posted.push({ url, message }),
    ...over,
  };
  const settle = () => Promise.all(deferred);
  return { deps, approvals, posted, executed, asked, settle };
}

const RESPONSE_URL = "https://hooks.slack.com/actions/T1/1/abc";

const commandBody = (text: string, user = "U_ALEX") =>
  new URLSearchParams({ command: "/jarvis", text, user_id: user, user_name: "alex", team_id: "T1", response_url: RESPONSE_URL }).toString();

const clickBody = (actionId: string, id: number, user = "U_ALEX") =>
  new URLSearchParams({
    payload: JSON.stringify({ type: "block_actions", user: { id: user, username: "alex" }, team: { id: "T1" }, response_url: RESPONSE_URL, actions: [{ action_id: actionId, value: String(id) }] }),
  }).toString();

// ---------- signatures ----------

test("valid signature passes", () => {
  const body = "token=x&text=hello";
  const ts = String(NOW);
  assert.deepEqual(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: signSlackRequest(SECRET, ts, body), body, nowSeconds: NOW }), { ok: true });
});

test("matches Slack's documented example signature", () => {
  // https://api.slack.com/authentication/verifying-requests-from-slack
  const body =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  assert.equal(signSlackRequest("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", body), "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
});

test("tampered body, wrong secret, stale or missing headers fail", () => {
  const ts = String(NOW);
  const sig = signSlackRequest(SECRET, ts, "a=1");
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, body: "a=2", nowSeconds: NOW }).ok, false);
  assert.equal(verifySlackSignature({ signingSecret: "other", timestamp: ts, signature: sig, body: "a=1", nowSeconds: NOW }).ok, false);
  assert.deepEqual(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, body: "a=1", nowSeconds: NOW + 301 }), { ok: false, reason: "stale timestamp" });
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: null, signature: sig, body: "a=1", nowSeconds: NOW }).ok, false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: "v0=short", body: "a=1", nowSeconds: NOW }).ok, false);
  assert.equal(verifySlackSignature({ signingSecret: undefined, timestamp: ts, signature: sig, body: "a=1", nowSeconds: NOW }).ok, false);
});

test("handler rejects unsigned requests with 401 and does nothing", async () => {
  const f = fakes();
  const res = await handleSlack(signed(commandBody("who owes us?"), { secret: "wrong" }), f.deps);
  assert.equal(res.status, 401);
  await f.settle();
  assert.equal(f.asked.length, 0);
  assert.equal(f.posted.length, 0);
});

test("handler returns 503 when SLACK_SIGNING_SECRET is missing", async () => {
  const f = fakes({ signingSecret: undefined });
  assert.equal((await handleSlack(signed(commandBody("hi")), f.deps)).status, 503);
});

// ---------- /jarvis ----------

test("/jarvis acknowledges at once, then posts the answer to response_url", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakes();
  f.deps.askJarvis = async (q) => {
    f.asked.push(q);
    await gate; // Jarvis is slow
    return { text: "## Outstanding\n**€1,845** across 2 clients.", runId: 42, ok: true };
  };

  const t0 = Date.now();
  const res = await handleSlack(signed(commandBody("who owes us money?")), f.deps);
  assert.ok(Date.now() - t0 < 3000, "must answer within Slack's 3 seconds");
  assert.equal(res.status, 200);
  assert.match((res.json as { text: string }).text, /Thinking about/);
  assert.equal(f.posted.length, 0, "the answer comes later");

  release();
  await f.settle();
  assert.deepEqual(f.asked, ["who owes us money?"]);
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].url, RESPONSE_URL);
  const text = f.posted[0].message.text as string;
  assert.match(text, /\*Outstanding\*/);
  assert.match(text, /\*€1,845\*/);
  assert.match(text, /<https:\/\/os\.example\/agents\/runs\/42\|See the run>/);
});

test("/jarvis with no question shows help and runs nothing", async () => {
  const f = fakes();
  const res = await handleSlack(signed(commandBody("")), f.deps);
  assert.match((res.json as { text: string }).text, /Ask Jarvis anything/);
  await f.settle();
  assert.equal(f.asked.length, 0);
});

test("/jarvis from someone not on the allow list is refused", async () => {
  const f = fakes({ allowedUserIds: ["U_ALEX"] });
  const res = await handleSlack(signed(commandBody("who owes us?", "U_STRANGER")), f.deps);
  assert.match((res.json as { text: string }).text, /not on the 1Media OS list/);
  await f.settle();
  assert.equal(f.asked.length, 0);
});

test("/jarvis from another workspace is refused", async () => {
  const f = fakes({ teamId: "T_OTHER" });
  const res = await handleSlack(signed(commandBody("who owes us?")), f.deps);
  assert.match((res.json as { text: string }).text, /workspace/);
});

test("Jarvis errors are reported back to Slack, not swallowed", async () => {
  const f = fakes({ askJarvis: async () => Promise.reject(new Error("Missing ANTHROPIC_API_KEY")) });
  await handleSlack(signed(commandBody("hi there")), f.deps);
  await f.settle();
  assert.match(f.posted[0].message.text as string, /Missing ANTHROPIC_API_KEY/);
});

// ---------- approval buttons ----------

test("Approve runs the action once and reports back", async () => {
  const f = fakes();
  const res = await handleSlack(signed(clickBody(ACTION_APPROVE, 7)), f.deps);
  assert.equal(res.status, 200);
  await f.settle();
  assert.deepEqual(f.executed, [7]);
  assert.equal(f.approvals.get(7)!.status, "executed");
  assert.match(f.posted[0].message.text as string, /Approved by alex and done/);
});

test("double click: the second Approve does not run it again", async () => {
  const f = fakes();
  await Promise.all([handleSlack(signed(clickBody(ACTION_APPROVE, 7)), f.deps), handleSlack(signed(clickBody(ACTION_APPROVE, 7)), f.deps)]);
  await f.settle();
  assert.deepEqual(f.executed, [7]);
  assert.ok(f.posted.some((p) => /already decided; nothing ran/.test(p.message.text as string)));
});

test("an already-executed approval is not run again", async () => {
  const f = fakes();
  await handleSlack(signed(clickBody(ACTION_APPROVE, 9)), f.deps);
  await f.settle();
  assert.deepEqual(f.executed, []);
});

test("guardrails still apply: approving a hard-blocked action doesn't run it", async () => {
  const f = fakes();
  await handleSlack(signed(clickBody(ACTION_APPROVE, 8)), f.deps);
  await f.settle();
  assert.equal(f.approvals.get(8)!.status, "failed");
  assert.match(f.posted[0].message.text as string, /didn't run.*Deleting data is never automatic/);
});

test("Reject marks it rejected and runs nothing", async () => {
  const f = fakes();
  await handleSlack(signed(clickBody(ACTION_REJECT, 7)), f.deps);
  await f.settle();
  assert.equal(f.approvals.get(7)!.status, "rejected");
  assert.deepEqual(f.executed, []);
  assert.match(f.posted[0].message.text as string, /Rejected by alex/);
});

test("buttons from someone not on the allow list do nothing", async () => {
  const f = fakes({ allowedUserIds: ["U_ALEX"] });
  await handleSlack(signed(clickBody(ACTION_APPROVE, 7, "U_STRANGER")), f.deps);
  await f.settle();
  assert.equal(f.approvals.get(7)!.status, "pending");
  assert.deepEqual(f.executed, []);
  assert.match(f.posted[0].message.text as string, /not on the 1Media OS list/);
});

test("a forged click (bad signature) changes nothing", async () => {
  const f = fakes();
  const res = await handleSlack(signed(clickBody(ACTION_APPROVE, 7), { secret: "forged" }), f.deps);
  assert.equal(res.status, 401);
  await f.settle();
  assert.equal(f.approvals.get(7)!.status, "pending");
});

test("approval notification has Approve and Reject buttons carrying the approval id", () => {
  const blocks = approvalBlocks({
    title: "*inbox* finished – 1 action(s) waiting for approval.",
    summary: "Processed 12 emails.",
    approvals: [{ id: 7, agent: "inbox", tool: "GMAIL_REPLY_TO_THREAD", input: { message_body: "Hi John,\nOn it." }, label: "reply to thread to john@example.com" }],
    appUrl: "https://os.example",
  }) as { type: string; elements?: { action_id?: string; value?: string; confirm?: unknown }[]; text?: { text: string } }[];
  const actions = blocks.find((b) => b.type === "actions")!;
  assert.deepEqual(actions.elements!.map((e) => [e.action_id, e.value]), [[ACTION_APPROVE, "7"], [ACTION_REJECT, "7"]]);
  assert.ok(actions.elements![0].confirm, "approve asks for confirmation");
  assert.ok(blocks.some((b) => b.text?.text.includes(">Hi John,\n>On it.")));
  assert.ok(JSON.stringify(blocks).includes("https://os.example/approvals"));
});

test("markdown converts to Slack mrkdwn", () => {
  assert.equal(toSlackMrkdwn("## Cash\n**€10** owed\n- [Stripe](https://stripe.com)"), "*Cash*\n*€10* owed\n• <https://stripe.com|Stripe>");
});

// ---------- agent safety for W7 ----------

test("Jarvis (the Slack question path) is read-only", () => {
  assert.equal(AGENTS.jarvis.autonomy, "L0");
  assert.equal(decide("OS_CREATE_TASK", AGENTS.jarvis.autonomy).action, "block");
});

test("inbox replies wait for approval and the inbox agent can't send any other way", () => {
  assert.equal(decide("GMAIL_REPLY_TO_THREAD", AGENTS.inbox.autonomy).action, "propose");
  for (const t of ["GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_FORWARD_MESSAGE", "GMAIL_MOVE_TO_TRASH"]) assert.ok(isExcluded(AGENTS.inbox, t), t);
  for (const t of ["GMAIL_FETCH_EMAILS", "GMAIL_REPLY_TO_THREAD", "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT"]) assert.ok(!isExcluded(AGENTS.inbox, t), t);
  assert.ok(AGENTS.inbox.osTools!.includes("OS_CREATE_TASK") && AGENTS.inbox.osTools!.includes("OS_SAVE_BRIEF"));
});

test("call prep only reads outside the OS", () => {
  for (const t of ["HIGHLEVEL_CREATE_CONTACT", "HIGHLEVEL_SEND_SMS", "GOOGLECALENDAR_CREATE_EVENT"]) assert.ok(isExcluded(AGENTS.meetings, t), t);
  for (const t of ["HIGHLEVEL_SEARCH_CONTACTS", "GOOGLECALENDAR_EVENTS_LIST", "METAADS_GET_INSIGHTS"]) assert.ok(!isExcluded(AGENTS.meetings, t), t);
});

test("client health can only save through the scoring rules", () => {
  assert.ok(AGENTS["client-health"].osTools!.includes("OS_SCORE_HEALTH"));
  assert.ok(!AGENTS["client-health"].osTools!.includes("OS_SAVE_HEALTH_CHECK"));
});
