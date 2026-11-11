import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { finance } from "../src/agents/finance";
import { createTestDb, dropTestDb, skipReason } from "./helpers/test-db";

// The finance agent's tool layer with the model mocked: a scripted "model" calls the real OS tools
// through the real runner and guardrails, against a throwaway database.

test("finance task asks for the cash summary on Fridays only", () => {
  assert.match(finance.task({ today: "2026-11-13" }), /Friday[\s\S]*OS_SAVE_CASH_SUMMARY/);
  assert.doesNotMatch(finance.task({ today: "2026-11-11" }), /OS_SAVE_CASH_SUMMARY/);
  assert.match(finance.prompt, /Never use Gmail tools to send or draft chasers/);
  assert.ok(finance.osTools?.includes("OS_QUEUE_CHASER"));
});

type Block = Anthropic.Beta.BetaContentBlock;
type Params = Anthropic.Beta.MessageCreateParams;

/** A fake Anthropic client that plays a script: each step sees the messages so far and returns content. */
function scriptedModel(steps: ((messages: Params["messages"]) => Block[])[]) {
  const seen: Params[] = [];
  let i = 0;
  const create = async (params: Params) => {
    seen.push(params);
    const content = steps[Math.min(i++, steps.length - 1)](params.messages);
    return {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    };
  };
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, seen };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }) as unknown as Block;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;

/** The JSON result of the most recent tool call with this id. */
function resultOf(messages: Params["messages"], id: string): any {
  for (const m of [...messages].reverse()) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === id) return JSON.parse(String(b.content));
    }
  }
  throw new Error(`no result for ${id}`);
}

describe("finance agent (database, model mocked)", { skip: skipReason }, () => {
  let db: typeof import("../src/db");
  let runAgent: typeof import("../src/lib/runner").runAgent;
  let executeApproval: typeof import("../src/lib/approvals").executeApproval;
  const slack: string[] = [];
  const realFetch = globalThis.fetch;

  before(async () => {
    await createTestDb();
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/T000/B000/xyz";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://hooks.slack.test/")) {
        slack.push(JSON.parse(String(init?.body)).text);
        return new Response("ok");
      }
      throw new Error(`unexpected network call to ${url}`);
    }) as typeof fetch;

    db = await import("../src/db");
    ({ runAgent } = await import("../src/lib/runner"));
    ({ executeApproval } = await import("../src/lib/approvals"));
    const { generateMonth } = await import("../src/lib/billing");
    const { addMonths, monthStart, today } = await import("../src/lib/dates");
    const { schema } = db;
    await db.db.insert(schema.clients).values([
      { name: "Late Payer Ltd", retainerExVat: 1000, vat: "plus", contactName: "Pat", email: "pat@late.example" },
      { name: "On Time Co", retainerExVat: 500, vat: "none", contactName: "Mary", email: "mary@ontime.example" },
      { name: "No Email Builders", retainerExVat: 800, vat: "none" },
    ]);
    // Two months back and last month: Late Payer owes both, On Time paid, No Email owes.
    const m2 = addMonths(monthStart(), -2);
    const m1 = addMonths(monthStart(), -1);
    await generateMonth(m2);
    await generateMonth(m1);
    const rows = await db.db.select().from(schema.payments);
    const clients = await db.db.select().from(schema.clients);
    const onTime = clients.find((c) => c.name === "On Time Co")!;
    for (const p of rows.filter((r) => r.clientId === onTime.id)) {
      const { eq } = await import("drizzle-orm");
      await db.db.update(schema.payments).set({ amountCollected: p.amountDue, paidDate: today() }).where(eq(schema.payments.id, p.id));
    }
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await dropTestDb();
  });

  /** The model reads receivables, queues a chaser for each client that has one due (twice, to test dedupe), and saves the cash summary. */
  const fridayScript = () =>
    scriptedModel([
      () => [text("Checking receivables."), toolUse("t1", "OS_GET_RECEIVABLES", {})],
      (messages) => {
        const r = resultOf(messages, "t1");
        const calls = r.clients
          .filter((c: any) => c.chaserDue)
          .flatMap((c: any, n: number) => [
            toolUse(`c${n}`, "OS_QUEUE_CHASER", { client_id: c.clientId, stage: c.chaserDue, subject: `Payment reminder: ${c.clientName}`, body: `Hi, a quick reminder that ${c.balance} is overdue. Thanks, Alex, 1Media` }),
            toolUse(`d${n}`, "OS_QUEUE_CHASER", { client_id: c.clientId, stage: c.chaserDue, subject: "dup", body: "duplicate chaser that should be skipped" }),
          ]);
        return [...calls, toolUse("s1", "OS_SAVE_CASH_SUMMARY", { commentary: "Late Payer Ltd is over 30 days late: call Pat." })];
      },
      () => [text("Done. 1 chaser queued for approval. Cash summary saved.")],
    ]);

  test("queues chasers as approvals (never sends), dedupes, flags missing email, saves and posts the cash summary", async () => {
    const { client, seen } = fridayScript();
    const run = await runAgent(finance, { client, trigger: "manual" });
    assert.equal(run.status, "completed", run.summary ?? "");

    // The model was offered the finance tools and no Gmail tools (Composio isn't configured).
    const toolNames = (seen[0].tools ?? []).map((t) => (t as { name: string }).name);
    assert.ok(toolNames.includes("OS_QUEUE_CHASER") && toolNames.includes("OS_SAVE_CASH_SUMMARY") && toolNames.includes("OS_GET_RECEIVABLES"));
    assert.ok(!toolNames.some((n) => n.startsWith("GMAIL_")));

    // Receivables the model saw: Late Payer and No Email owe; On Time doesn't.
    const r = resultOf(seen[1].messages, "t1");
    assert.deepEqual(r.clients.map((c: any) => c.clientName).sort(), ["Late Payer Ltd", "No Email Builders"]);
    assert.equal(r.clients.find((c: any) => c.clientName === "Late Payer Ltd").balance, 2460);
    assert.equal(r.clients.find((c: any) => c.clientName === "Late Payer Ltd").chaserDue, "14");

    const { schema } = db;
    const approvals = await db.db.select().from(schema.approvals);
    assert.equal(approvals.length, 1, "one chaser (No Email can't be chased; the duplicate is skipped)");
    const [a] = approvals;
    assert.equal(a.status, "pending");
    assert.equal(a.tool, "GMAIL_SEND_EMAIL");
    assert.equal(a.agent, "finance");
    assert.equal(a.runId, run.id);
    assert.deepEqual(Object.keys(a.input).sort(), ["body", "recipient_email", "subject"]);
    assert.equal(a.input.recipient_email, "pat@late.example");
    assert.match(a.reason ?? "", /14-day chaser for Late Payer Ltd: €2,460 owed/);

    const events = run.events;
    assert.ok(events.some((e) => e.tool === "OS_QUEUE_CHASER" && e.outcome === "error" && /no email on file/.test(e.note ?? "")));
    assert.ok(events.some((e) => e.tool === "OS_QUEUE_CHASER" && /already exists/.test(e.result ?? "")));

    const [summary] = await db.db.select().from(schema.cashSummaries);
    assert.equal(summary.runId, run.id);
    assert.equal(summary.postedToSlack, true);
    assert.match(summary.body, /Outstanding \(due and unpaid\): €4,060/);
    assert.match(summary.body, /31–60 days: €2,030 \(2 rows\)[\s\S]*60\+ days: €2,030 \(2 rows\)/);
    assert.match(summary.body, /Late Payer Ltd is over 30 days late: call Pat\./);
    assert.ok(slack.some((s) => s.startsWith("Cash summary")));
  });

  test("a second run doesn't queue the same chaser again", async () => {
    const { client } = fridayScript();
    await runAgent(finance, { client, trigger: "manual" });
    const approvals = await db.db.select().from(db.schema.approvals);
    assert.equal(approvals.length, 1);
  });

  test("approving a chaser without Composio fails safely: nothing is sent", async () => {
    const [a] = await db.db.select().from(db.schema.approvals);
    const r = await executeApproval(a.id);
    assert.equal(r.ok, false);
    assert.match(r.result, /COMPOSIO_API_KEY is not set/);
  });

  test("dry run (L0) blocks chasers and the summary", async () => {
    const before = (await db.db.select().from(db.schema.cashSummaries)).length;
    const { client } = fridayScript();
    const run = await runAgent(finance, { client, trigger: "manual", dryRun: true });
    assert.ok(run.events.filter((e) => e.tool !== "OS_GET_RECEIVABLES").every((e) => e.outcome === "blocked"));
    assert.equal((await db.db.select().from(db.schema.cashSummaries)).length, before);
  });
});
