import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { runState, toPoll, STALE_AFTER_MS } from "../src/lib/runs";
import type { AgentRun } from "../src/db/schema";

// ---------- pure helpers (no database) ----------

const base = { status: "running" as const, startedAt: new Date() };

test("a fresh running run is running", () => {
  assert.equal(runState(base), "running");
});

test("a run still 'running' past the time limit shows as stalled", () => {
  assert.equal(runState({ ...base, startedAt: new Date(Date.now() - STALE_AFTER_MS - 1000) }), "stalled");
});

test("finished runs keep their status", () => {
  for (const s of ["completed", "stopped", "error"] as const) assert.equal(runState({ status: s, startedAt: new Date(0) }), s);
});

test("toPoll only exposes the answer once the run is done", () => {
  const run = { id: 1, status: "running", startedAt: new Date(), finishedAt: null, instruction: "q", summary: "partial", error: null, toolCalls: 2 } as unknown as AgentRun;
  assert.equal(toPoll(run).answer, null);
  assert.equal(toPoll({ ...run, status: "completed" }).answer, "partial");
  assert.equal(toPoll({ ...run, status: "error", error: "boom" }).error, "boom");
});

// ---------- the Jarvis loop end to end, with the Anthropic call mocked ----------
// Needs a database: DATABASE_URL=postgres://postgres@localhost:5433/postgres npm test

const hasDb = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);

if (hasDb) {
  const { db, schema, closeDb } = await import("../src/db");
  const { runAgent, createRun, executeRun } = await import("../src/lib/runner");
  const { AGENTS } = await import("../src/agents/registry");
  after(() => closeDb());

  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 };

  /** A fake client that replays scripted responses and records each request. */
  function fakeClient(responses: unknown[]) {
    const requests: any[] = [];
    return {
      requests,
      client: {
        beta: {
          messages: {
            create: (async (req: unknown) => {
              requests.push(structuredClone(req));
              const r = responses.shift();
              if (r instanceof Error) throw r;
              return r;
            }) as any,
          },
        },
      },
    };
  }

  test("Jarvis: tool call, then answer; run saves events, tokens and the answer", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "toolu_1", name: "OS_LIST_CLIENTS", input: {} }] },
      { stop_reason: "end_turn", usage, content: [{ type: "text", text: "## Who owes us\n\n| Client | Owed |\n|---|---|\n| Acme | €1,230 |" }] },
    ]);
    const run = await createRun(AGENTS.jarvis, { instruction: "Who owes us money?", trigger: "manual" });
    assert.equal(run.status, "running");
    const saved = await executeRun(run, AGENTS.jarvis, { instruction: "Who owes us money?", trigger: "manual" }, { client });

    assert.equal(saved.status, "completed");
    assert.match(saved.summary ?? "", /Who owes us/);
    assert.equal(saved.error, null);
    assert.equal(saved.toolCalls, 1);
    assert.equal(saved.inputTokens, 200);
    assert.equal(saved.outputTokens, 40);
    assert.equal(saved.cacheReadTokens, 100);
    const [e] = saved.events;
    assert.equal(e.id, "toolu_1");
    assert.equal(e.tool, "OS_LIST_CLIENTS");
    assert.equal(e.outcome, "ran");
    assert.equal(e.turn, 1);
    assert.equal(typeof e.ms, "number");
    assert.ok(e.result && e.result.startsWith("["), "tool output is saved");
    // The question reached the model, and the tool result went back in turn 2.
    assert.match(JSON.stringify(requests[0].messages), /Who owes us money\?/);
    assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, "toolu_1");

    const poll = toPoll(saved);
    assert.equal(poll.status, "completed");
    assert.match(poll.answer ?? "", /Acme/);
  });

  test("Jarvis is read-only: a write tool is blocked and logged", async () => {
    const { client } = fakeClient([
      { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "toolu_w", name: "OS_CREATE_TASK", input: { title: "x" } }] },
      { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Couldn't create it." }] },
    ]);
    const saved = await runAgent(AGENTS.jarvis, { instruction: "make a task" }, { client });
    assert.equal(saved.blocked, 1);
    assert.equal(saved.events[0].outcome, "blocked");
  });

  test("a failed run saves the error and pings Slack with a link", async () => {
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
    process.env.APP_URL = "https://os.example.ie";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posted.push(String(init?.body));
      return new Response("ok");
    }) as typeof fetch;
    try {
      const { client } = fakeClient([new Error("overloaded_error: try later")]);
      const saved = await runAgent(AGENTS.jarvis, { instruction: "hi" }, { client });
      assert.equal(saved.status, "error");
      assert.equal(saved.error, "overloaded_error: try later");
      assert.ok(saved.finishedAt);
      assert.equal(posted.length, 1);
      const text = JSON.parse(posted[0]).text as string;
      assert.match(text, /jarvis\* failed/);
      assert.ok(text.includes(`https://os.example.ie/agents/runs/${saved.id}`));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_WEBHOOK_URL;
      delete process.env.APP_URL;
    }
  });

  test("without ANTHROPIC_API_KEY the run fails fast with a clear error", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const saved = await runAgent(AGENTS.jarvis, { instruction: "hi" });
      assert.equal(saved.status, "error");
      assert.match(saved.error ?? "", /ANTHROPIC_API_KEY/);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, saved.id));
      assert.equal(row.status, "error");
    } finally {
      if (key) process.env.ANTHROPIC_API_KEY = key;
    }
  });
} else {
  test("runner database tests", { skip: "set DATABASE_URL to run them" }, () => {});
}

test("Anthropic API errors are described in plain English", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const { describeError } = await import("../src/lib/runner");
  const overloaded = Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
  assert.match(describeError(overloaded), /^Claude is overloaded right now \(529\)/);
  const auth = Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, undefined, new Headers());
  assert.match(describeError(auth), /ANTHROPIC_API_KEY/);
  assert.equal(describeError(new Error("plain")), "plain");
});
