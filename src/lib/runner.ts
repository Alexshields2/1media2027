import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolUseBlock } from "@composio/anthropic";
import { eq } from "drizzle-orm";
import { MODEL, config, requireEnv } from "../config";
import { db, schema } from "../db";
import type { ToolEvent, AgentRun } from "../db/schema";
import { composio, loadComposioTools, composioEnabled } from "./composio";
import { decide, type Autonomy } from "./guardrails";
import { osToolDefs, isOsTool, runOsTool, ALL_OS_TOOLS } from "./os-tools";
import { today } from "./dates";
import { notify } from "./slack";
import { houseRules } from "../agents/house-rules";
import type { AgentDefinition, AgentContext } from "../agents/types";

/** AGENTS_MOCK=true swaps the model and Meta/GHL for scripted fixtures (local demos and previews; never production). */
export function mockModeEnabled(): boolean {
  return process.env.AGENTS_MOCK === "true" && process.env.VERCEL_ENV !== "production";
}

async function mockDepsIfEnabled(): Promise<RunDeps | undefined> {
  if (!mockModeEnabled()) return undefined;
  const { mockDeps } = await import("./mock-agents");
  return mockDeps();
}

/** House rules + the agent's own prompt. Kept stable (no dates) so it caches across runs. */
function systemPrompt(agent: AgentDefinition, autonomy: Autonomy): string {
  return [
    houseRules,
    `# Your role: ${agent.name}\n\n${agent.prompt}`,
    `# Your autonomy level: ${autonomy}\n\nWrite actions you are not cleared for come back as "PROPOSED" or "BLOCKED" instead of running. That is expected: carry on, and list every proposed action in your final summary so a human can approve it.`,
  ].join("\n\n---\n\n");
}

/** The one Messages API call the runner makes. Swappable so tests (and AGENTS_MOCK) can script the model. */
export interface ModelClient {
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

/** An Anthropic-SDK-shaped client (`client.beta.messages.create`); tests may pass a fake of this instead of a ModelClient. */
export type SdkLikeClient = { beta: { messages: { create: Anthropic["beta"]["messages"]["create"] } } };

/** External (non-OS) tools: Composio in production, fixtures in tests. */
export interface ExternalTools {
  defs: Anthropic.Beta.BetaToolUnion[];
  execute(name: string, input: Record<string, unknown>, callId: string): Promise<string>;
}

export interface RunDeps {
  model?: ModelClient;
  /** Same as `model`, in Anthropic SDK shape. */
  client?: SdkLikeClient;
  external?: ExternalTools;
}

export interface RunOptions {
  dryRun?: boolean;
  instruction?: string;
  trigger?: AgentRun["trigger"];
  /** Scope the run to one client (per-client report jobs). */
  client?: AgentContext["client"];
  /** The reporting period for report agents. */
  period?: AgentContext["period"];
  /** Epoch ms. No new model turn starts after this, so the run is saved before the function is killed. */
  deadline?: number;
  deps?: RunDeps;
}

function defaultModel(): ModelClient {
  requireEnv("ANTHROPIC_API_KEY");
  const client = new Anthropic();
  return { create: (params) => client.beta.messages.create(params) };
}

function modelFrom(deps: RunDeps | undefined): ModelClient {
  if (deps?.model) return deps.model;
  const sdk = deps?.client;
  if (sdk) return { create: (params) => sdk.beta.messages.create(params) as Promise<Anthropic.Beta.BetaMessage> };
  return defaultModel();
}

async function composioTools(agent: AgentDefinition): Promise<ExternalTools> {
  const defs = (await loadComposioTools({ toolkits: agent.toolkits, tools: agent.tools })) as Anthropic.Beta.BetaToolUnion[];
  return {
    defs,
    execute: (name, input, callId) => {
      const toolUse: AnthropicToolUseBlock = { type: "tool_use", id: callId, name, input };
      return composio().provider.executeToolCall(config.composioUserId, toolUse);
    },
  };
}

/** Inserts the run row (status "running") so callers get its id before the loop starts. */
export async function createRun(agent: AgentDefinition, opts: RunOptions = {}): Promise<AgentRun> {
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ agent: agent.name, trigger: opts.trigger ?? "manual", dryRun: !!opts.dryRun, instruction: opts.instruction })
    .returning();
  return run;
}

/** Creates a run and executes it to the end. */
export async function runAgent(agent: AgentDefinition, opts: RunOptions = {}, deps?: RunDeps): Promise<AgentRun> {
  return executeRun(await createRun(agent, opts), agent, opts, deps);
}

/** Runs the agent loop for a run created with createRun, saving progress after every turn. */
export async function executeRun(run: AgentRun, agent: AgentDefinition, opts: RunOptions = {}, depsArg?: RunDeps): Promise<AgentRun> {
  const autonomy: Autonomy = opts.dryRun ? "L0" : agent.autonomy;
  const ctx: AgentContext = { today: today(), instruction: opts.instruction, client: opts.client, period: opts.period };
  const task = agent.task(ctx) + (ctx.instruction ? `\n\nExtra instruction for this run: ${ctx.instruction}` : "");

  const events: ToolEvent[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let summary: string | undefined;
  let error: string | undefined;
  let status: AgentRun["status"] = "completed";

  const count = (o: ToolEvent["outcome"]) => events.filter((e) => e.outcome === o).length;
  const progress = () => ({
    events,
    toolCalls: events.length,
    proposed: count("proposed"),
    blocked: count("blocked"),
    errors: count("error"),
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
  });

  try {
    const deps = depsArg ?? opts.deps ?? (await mockDepsIfEnabled());
    const model = modelFrom(deps);
    const external = deps?.external ?? (await composioTools(agent));
    const tools = [...osToolDefs(agent.osTools ?? ALL_OS_TOOLS), ...external.defs] as Anthropic.Beta.BetaToolUnion[];
    const system = systemPrompt(agent, autonomy);
    const note = external.defs.length || composioEnabled() ? "" : "\n\n(Note: external apps such as Gmail, Meta Ads, HighLevel and Stripe are not connected yet. Work with the 1Media OS database only, and say what you could not check.)";
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task + note }];

    for (let turn = 0; turn < agent.maxTurns; turn++) {
      if (opts.deadline && Date.now() > opts.deadline) {
        summary = `Run stopped: out of time after ${turn} turns (per-run time budget).`;
        status = "stopped";
        break;
      }
      const res = await model.create({
        model: MODEL,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: agent.effort },
        // If a safety classifier declines, the server retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;

      if (res.stop_reason === "refusal") {
        summary = "Run stopped: the model declined this request.";
        status = "stopped";
        break;
      }

      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "pause_turn") continue;

      if (res.stop_reason !== "tool_use") {
        summary = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (res.stop_reason === "max_tokens") status = "stopped";
        break;
      }

      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      // Run the calls in parallel, then return every result in one user message.
      const results = await Promise.all(calls.map((c) => handleCall(c, agent, autonomy, run.id, events, turn + 1, external)));
      messages.push({ role: "user", content: results });
      // Save progress so the run page shows tool calls while the run is still going.
      await db.update(schema.agentRuns).set(progress()).where(eq(schema.agentRuns.id, run.id)).catch(() => {});
    }

    if (summary === undefined) {
      summary = `Run stopped after ${agent.maxTurns} turns without finishing.`;
      status = "stopped";
    }
  } catch (err) {
    status = "error";
    error = describeError(err);
    summary = `Error: ${error}`;
  }

  const [saved] = await db
    .update(schema.agentRuns)
    .set({ ...progress(), status, summary, error, finishedAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id))
    .returning();

  const proposed = count("proposed");
  if (proposed || status === "error") {
    const link = runUrl(run.id);
    await notify(
      `${status === "error" ? ":red_circle: " : ""}*${agent.name}* ${status === "error" ? "failed" : "finished"}${proposed ? ` – ${proposed} action(s) waiting for approval` : ""}.\n${(summary ?? "").slice(0, 1500)}${link ? `\n<${link}|Open run #${run.id}>` : ""}`,
    );
  }
  return saved;
}

/** A readable one-liner for a failure; Anthropic API errors otherwise come through as "529 {json}". */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: string; message?: string } } | undefined;
    const type = body?.error?.type;
    const message = body?.error?.message;
    if (err.status === 529 || type === "overloaded_error") return `Claude is overloaded right now (${err.status}). Try again in a minute.${message ? ` (${message})` : ""}`;
    if (err.status === 401) return "The Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY.";
    if (err.status === 429) return `Rate limited by the Anthropic API (429).${message ? ` ${message}` : ""}`;
    if (type || message) return `Anthropic API error ${err.status ?? ""}${type ? ` ${type}` : ""}: ${message ?? ""}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/** Absolute link to a run page, when the app's URL is known (APP_URL, or Vercel's production URL). */
export function runUrl(id: number): string | undefined {
  const base = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return base ? `${base.replace(/\/$/, "")}/agents/runs/${id}` : undefined;
}

async function handleCall(
  call: Anthropic.Beta.BetaToolUseBlock,
  agent: AgentDefinition,
  autonomy: Autonomy,
  runId: number,
  events: ToolEvent[],
  turn: number,
  external: ExternalTools,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const d = decide(call.name, autonomy, agent.allow);
  const started = Date.now();
  const event: ToolEvent = { id: call.id, tool: call.name, input, outcome: "ran", turn, at: new Date(started).toISOString() };
  events.push(event);

  if (d.action === "block") {
    event.outcome = "blocked";
    event.note = d.reason;
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `BLOCKED: ${d.reason} Do not retry this action.` };
  }

  if (d.action === "propose") {
    event.outcome = "proposed";
    event.note = d.reason;
    await db.insert(schema.approvals).values({ runId, agent: agent.name, tool: call.name, input, reason: d.reason });
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `PROPOSED (not executed): ${d.reason} It is queued in the 1Media OS approvals page. Continue as if it will be done, and list it in your summary.`,
    };
  }

  try {
    const out = isOsTool(call.name) ? await runOsTool(call.name, input, { runId, agent: agent.name }) : await external.execute(call.name, input, call.id);
    event.result = out.length > 8000 ? out.slice(0, 8000) + "…[truncated in log only]" : out;
    event.ms = Date.now() - started;
    return { type: "tool_result", tool_use_id: call.id, content: out };
  } catch (err) {
    event.outcome = "error";
    event.note = err instanceof Error ? err.message : String(err);
    event.ms = Date.now() - started;
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool error: ${event.note}` };
  }
}
