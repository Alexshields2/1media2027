import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, dropTestDb, skipReason } from "./helpers/test-db";
import type { ChatEvent, ChatModel, ChatUser } from "../src/lib/chat/engine";

// The chat tool loop end to end against a throwaway database, with the model mocked.
// Run with TEST_DATABASE_URL set (see helpers/test-db.ts).

describe("chat engine (database)", { skip: skipReason }, () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let engine: typeof import("../src/lib/chat/engine");
  let profiles: typeof import("../src/lib/chat/profiles");
  let eq: typeof import("drizzle-orm").eq;
  let owner: ChatUser;
  let team: ChatUser;

  before(async () => {
    await createTestDb();
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.COMPOSIO_API_KEY;
    ({ db, schema } = await import("../src/db"));
    ({ eq } = await import("drizzle-orm"));
    engine = await import("../src/lib/chat/engine");
    profiles = await import("../src/lib/chat/profiles");
    const [o, t] = await db
      .insert(schema.users)
      .values([
        { email: "owner@example.com", name: "Alex", role: "owner" },
        { email: "team@example.com", name: "Jamie", role: "team" },
      ])
      .returning();
    owner = { id: o.id, name: o.name, role: "owner" };
    team = { id: t.id, name: t.name, role: "team" };
    await db.insert(schema.clients).values({ name: "Apex Attics", retainerExVat: 1500, stripeCustomerId: "cus_apex" });
    await profiles.ensureDefaultProfiles();
    await profiles.ensureDefaultProfiles(); // idempotent
  });
  after(dropTestDb);

  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 };

  /** A model that replays scripted responses, streams their text, and records each request. */
  function fakeModel(responses: unknown[]) {
    const requests: any[] = [];
    const model: ChatModel = {
      async stream(params, { onText, signal }) {
        requests.push(structuredClone(params));
        const r = responses.shift() as any;
        if (r instanceof Error) throw r;
        if (typeof r === "function") return r(signal, onText);
        for (const b of r.content) if (b.type === "text") onText(b.text);
        return { id: "msg", type: "message", role: "assistant", model: "fake", stop_sequence: null, usage, ...r };
      },
    };
    return { model, requests };
  }

  async function run(input: Partial<Parameters<typeof engine.runChatTurn>[0]> & { slug?: string }, model: ChatModel, deps: Partial<Parameters<typeof engine.runChatTurn>[2]> = {}) {
    const profile = (await profiles.getProfile(input.slug ?? "jarvis"))!;
    const events: ChatEvent[] = [];
    await engine.runChatTurn({ user: owner, profile, ...input }, (e) => events.push(e), { model, external: { defs: [], execute: async () => "{}" }, ...deps });
    const conv = events.find((e) => e.type === "conversation") as Extract<ChatEvent, { type: "conversation" }> | undefined;
    return { events, conversationId: conv?.id, errors: events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message) };
  }

  const rowsOf = (id: number) => db.select().from(schema.chatMessages).where(eq(schema.chatMessages.conversationId, id)).orderBy(schema.chatMessages.id);

  test("default profiles are seeded once", async () => {
    const all = await db.select().from(schema.agentProfiles);
    assert.equal(all.length, profiles.DEFAULT_PROFILES.length);
  });

  test("Jarvis: tool call, streamed answer, every API message saved in order", async () => {
    const { model, requests } = fakeModel([
      { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig1" }, { type: "tool_use", id: "toolu_1", name: "OS_LIST_CLIENTS", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "You have **one** client: Apex Attics." }] },
    ]);
    const { events, conversationId, errors } = await run({ text: "Which clients do we have?" }, model);
    assert.deepEqual(errors, []);
    assert.ok(conversationId);

    // Streamed to the browser: the conversation, a note that apps aren't connected, a running chip, the finished chip, the text, done.
    assert.deepEqual(events.map((e) => e.type), ["conversation", "notice", "tool", "tool", "text", "done"]);
    assert.match((events[1] as { text: string }).text, /aren't connected yet/);
    const chip = events[3] as Extract<ChatEvent, { type: "tool" }>;
    assert.equal(chip.event.outcome, "ran");
    assert.equal(chip.event.label, "Looked up clients");

    // Saved: person, assistant (tool call), tool result, assistant (answer).
    const rows = await rowsOf(conversationId!);
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant", "user", "assistant"]);
    assert.match(JSON.stringify(rows[0].content), /Which clients do we have\?/);
    assert.match(JSON.stringify(rows[0].content), /<context>Today is .* Asking: Alex \(owner\)/);
    assert.equal(rows[1].toolEvents[0].tool, "OS_LIST_CLIENTS");
    assert.equal(rows[1].inputTokens, 100);
    assert.match(JSON.stringify(rows[2].content), /tool_result.*Apex Attics/);
    assert.equal(rows[3].stopReason, "end_turn");

    // The request: cached system prompt, OS tools, adaptive thinking, fallbacks; turn 2 replays thinking + the tool result.
    const req = requests[0];
    assert.equal(req.model, "claude-opus-5-5");
    assert.equal(req.system[0].cache_control.type, "ephemeral");
    assert.match(req.system[0].text, /# Your role: Jarvis/);
    assert.deepEqual(req.thinking, { type: "adaptive" });
    assert.equal(req.fallbacks, "default");
    assert.ok(req.tools.some((t: any) => t.name === "OS_LIST_CLIENTS"));
    assert.ok(req.tools.some((t: any) => t.type === "web_search_20260209"));
    assert.equal(requests[1].messages[1].content[0].signature, "sig1");
    assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, "toolu_1");
    // The system prompt is the same on every turn (cache-friendly).
    assert.equal(requests[0].system[0].text, requests[1].system[0].text);

    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId!));
    assert.equal(conv.title, "Which clients do we have?");
    assert.equal(conv.userId, owner.id);
  });

  test("a follow-up continues the same conversation with the full history", async () => {
    const first = await run({ text: "hello" }, fakeModel([{ stop_reason: "end_turn", content: [{ type: "text", text: "Hi Alex." }] }]).model);
    const { model, requests } = fakeModel([{ stop_reason: "end_turn", content: [{ type: "text", text: "Still here." }] }]);
    const second = await run({ text: "and again", conversationId: first.conversationId }, model);
    assert.equal(second.conversationId, first.conversationId);
    assert.deepEqual(requests[0].messages.map((m: any) => m.role), ["user", "assistant", "user"]);
    assert.equal((second.events[0] as any).created, false);
  });

  test("L1 agent: a write becomes an approval linked to the chip; the tool doesn't run", async () => {
    const { model } = fakeModel([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_t", name: "OS_CREATE_TASK", input: { title: "Call Apex", client_id: 1 } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Proposed." }] },
    ]);
    const { events, conversationId } = await run({ slug: "fulfilment", text: "Make a task to call Apex" }, model);
    const done = events.filter((e) => e.type === "tool").at(-1) as Extract<ChatEvent, { type: "tool" }>;
    assert.equal(done.event.outcome, "proposed");
    assert.equal(done.event.label, "Create a task for Apex Attics – Call Apex");
    const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, done.event.approvalId!));
    assert.equal(a.agent, "fulfilment");
    assert.equal(a.tool, "OS_CREATE_TASK");
    assert.equal(a.status, "pending");
    assert.equal(a.runId, null);
    assert.equal((await db.select().from(schema.tasks)).length, 0);
    const rows = await rowsOf(conversationId!);
    assert.equal(rows[1].toolEvents[0].approvalId, a.id);
  });

  test("team members: no Payments agent, no money tools, no billing fields", async () => {
    const pay = await run({ slug: "payments", text: "who owes us", user: team }, fakeModel([]).model);
    assert.match(pay.errors[0], /can't use the Payments agent/);
    assert.equal(pay.conversationId, undefined);

    const { model, requests } = fakeModel([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "m1", name: "OS_GET_RECEIVABLES", input: {} }, { type: "tool_use", id: "m2", name: "OS_LIST_CLIENTS", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ]);
    const { events } = await run({ text: "what's owed and who are our clients?", user: team }, model);
    assert.ok(!requests[0].tools.some((t: any) => t.name === "OS_GET_RECEIVABLES" || t.name === "OS_LIST_PAYMENTS"));
    const final = events.filter((e): e is Extract<ChatEvent, { type: "tool" }> => e.type === "tool" && !e.event.running);
    assert.equal(final.find((e) => e.event.tool === "OS_GET_RECEIVABLES")!.event.outcome, "blocked");
    const results = requests[1].messages.at(-1).content;
    assert.match(results[0].content, /BLOCKED: Team members can't use money tools/);
    assert.match(results[1].content, /Apex Attics/);
    assert.doesNotMatch(results[1].content, /retainerExVat|cus_apex/);
  });

  test("a person can't continue someone else's conversation", async () => {
    const mine = await run({ text: "private" }, fakeModel([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]).model);
    const theirs = await run({ text: "peek", conversationId: mine.conversationId, user: team }, fakeModel([]).model);
    assert.match(theirs.errors[0], /doesn't exist/);
    assert.equal((await rowsOf(mine.conversationId!)).length, 2);
  });

  test("regenerate drops the last reply (rejecting what it proposed) and answers again", async () => {
    const first = await run(
      { slug: "fulfilment", text: "task please" },
      fakeModel([
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "r1", name: "OS_CREATE_TASK", input: { title: "x" } }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "first answer" }] },
      ]).model,
    );
    const approvalId = (first.events.filter((e) => e.type === "tool").at(-1) as any).event.approvalId;
    const { model, requests } = fakeModel([{ stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] }]);
    const again = await run({ slug: "fulfilment", conversationId: first.conversationId, regenerate: true }, model);
    assert.deepEqual(again.errors, []);
    assert.deepEqual(requests[0].messages.map((m: any) => m.role), ["user"]);
    const rows = await rowsOf(first.conversationId!);
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
    assert.match(JSON.stringify(rows[1].content), /second answer/);
    const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    assert.equal(a.status, "rejected");
  });

  test("a tool call cut off at max_tokens is neither run nor saved", async () => {
    const { events, conversationId } = await run(
      { text: "long one" },
      fakeModel([{ stop_reason: "max_tokens", content: [{ type: "text", text: "Partial" }, { type: "tool_use", id: "cut", name: "OS_LIST_CLIENTS", input: {} }] }]).model,
    );
    assert.ok(events.some((e) => e.type === "notice" && /cut off/.test(e.text)));
    assert.ok(!events.some((e) => e.type === "tool"));
    const rows = await rowsOf(conversationId!);
    assert.doesNotMatch(JSON.stringify(rows[1].content), /tool_use/);
  });

  test("Stop: the partial reply is saved as stopped", async () => {
    const ac = new AbortController();
    const slow = (signal: AbortSignal, onText: (d: string) => void) =>
      new Promise((_, reject) => {
        onText("Half an ans");
        ac.abort();
        reject(signal.reason ?? new Error("aborted"));
      });
    const { events, conversationId } = await run({ text: "stop me" }, fakeModel([slow]).model, { signal: ac.signal });
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "stopped" });
    const rows = await rowsOf(conversationId!);
    assert.equal(rows[1].stopReason, "stopped");
    assert.match(JSON.stringify(rows[1].content), /Half an ans/);
  });

  test("past the deadline no model call starts, and the chat says so", async () => {
    const { model, requests } = fakeModel([]);
    const { events } = await run({ text: "late" }, model, { deadline: Date.now() - 1 });
    assert.equal(requests.length, 0);
    assert.ok(events.some((e) => e.type === "notice" && /time limit/.test(e.text)));
  });

  test("API errors are shown in plain English; without a key the chat says what to do", async () => {
    const failed = await run({ text: "boom" }, fakeModel([new Error("socket hang up")]).model);
    assert.deepEqual(failed.errors, ["socket hang up"]);

    const key = process.env.ANTHROPIC_API_KEY;
    const mock = process.env.AGENTS_MOCK;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENTS_MOCK;
    try {
      const profile = (await profiles.getProfile("jarvis"))!;
      const events: ChatEvent[] = [];
      await engine.runChatTurn({ user: owner, profile, text: "hi" }, (e) => events.push(e));
      assert.equal((events[0] as any).message, engine.NO_KEY_MESSAGE);
    } finally {
      if (key) process.env.ANTHROPIC_API_KEY = key;
      if (mock) process.env.AGENTS_MOCK = mock;
    }
  });

  test("Reset to default puts the shipped instructions back", async () => {
    await db.update(schema.agentProfiles).set({ instructions: "custom", autonomy: "L2" }).where(eq(schema.agentProfiles.slug, "jarvis"));
    assert.equal(await profiles.resetProfile("jarvis"), true);
    const p = await profiles.getProfile("jarvis");
    assert.equal(p!.instructions, profiles.DEFAULT_BY_SLUG.jarvis.instructions);
    assert.equal(p!.autonomy, "L0");
    assert.equal(await profiles.resetProfile("not-a-default"), false);
  });
});
