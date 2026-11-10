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

/** House rules + the agent's own prompt. Kept stable (no dates) so it caches across runs. */
function systemPrompt(agent: AgentDefinition, autonomy: Autonomy): string {
  return [
    houseRules,
    `# Your role: ${agent.name}\n\n${agent.prompt}`,
    `# Your autonomy level: ${autonomy}\n\nWrite actions you are not cleared for come back as "PROPOSED" or "BLOCKED" instead of running. That is expected: carry on, and list every proposed action in your final summary so a human can approve it.`,
  ].join("\n\n---\n\n");
}

export interface RunOptions {
  dryRun?: boolean;
  instruction?: string;
  trigger?: AgentRun["trigger"];
}

export async function runAgent(agent: AgentDefinition, opts: RunOptions = {}): Promise<AgentRun> {
  const autonomy: Autonomy = opts.dryRun ? "L0" : agent.autonomy;
  const ctx: AgentContext = { today: today(), instruction: opts.instruction };
  const task = agent.task(ctx) + (ctx.instruction ? `\n\nExtra instruction for this run: ${ctx.instruction}` : "");

  const [run] = await db
    .insert(schema.agentRuns)
    .values({ agent: agent.name, trigger: opts.trigger ?? "manual", dryRun: !!opts.dryRun, instruction: opts.instruction })
    .returning();

  const events: ToolEvent[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let summary: string | undefined;
  let status: AgentRun["status"] = "completed";

  try {
    requireEnv("ANTHROPIC_API_KEY");
    const client = new Anthropic();
    const composioTools = await loadComposioTools({ toolkits: agent.toolkits, tools: agent.tools });
    const tools = [...osToolDefs(agent.osTools ?? ALL_OS_TOOLS), ...composioTools] as Anthropic.Beta.BetaToolUnion[];
    const system = systemPrompt(agent, autonomy);
    const note = composioEnabled() ? "" : "\n\n(Note: external apps such as Gmail, Meta Ads, HighLevel and Stripe are not connected yet. Work with the 1Media OS database only, and say what you could not check.)";
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task + note }];

    for (let turn = 0; turn < agent.maxTurns; turn++) {
      const res = await client.beta.messages.create({
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
      const results = await Promise.all(calls.map((c) => handleCall(c, agent, autonomy, run.id, events)));
      messages.push({ role: "user", content: results });
    }

    if (summary === undefined) {
      summary = `Run stopped after ${agent.maxTurns} turns without finishing.`;
      status = "stopped";
    }
  } catch (err) {
    status = "error";
    summary = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const count = (o: ToolEvent["outcome"]) => events.filter((e) => e.outcome === o).length;
  const [saved] = await db
    .update(schema.agentRuns)
    .set({
      status,
      summary,
      events,
      toolCalls: events.length,
      proposed: count("proposed"),
      blocked: count("blocked"),
      errors: count("error"),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      finishedAt: new Date(),
    })
    .where(eq(schema.agentRuns.id, run.id))
    .returning();

  const proposed = count("proposed");
  if (proposed || status === "error") {
    await notify(
      `*${agent.name}* ${status === "error" ? "failed" : "finished"}${proposed ? ` – ${proposed} action(s) waiting for approval` : ""}.\n${(summary ?? "").slice(0, 1500)}`,
    );
  }
  return saved;
}

async function handleCall(
  call: Anthropic.Beta.BetaToolUseBlock,
  agent: AgentDefinition,
  autonomy: Autonomy,
  runId: number,
  events: ToolEvent[],
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const d = decide(call.name, autonomy, agent.allow);
  const event: ToolEvent = { tool: call.name, input, outcome: "ran" };
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
    let out: string;
    if (isOsTool(call.name)) {
      out = await runOsTool(call.name, input);
    } else {
      const toolUse: AnthropicToolUseBlock = { type: "tool_use", id: call.id, name: call.name, input };
      out = await composio().provider.executeToolCall(config.composioUserId, toolUse);
    }
    event.result = out.length > 2000 ? out.slice(0, 2000) + "…[truncated in log only]" : out;
    return { type: "tool_result", tool_use_id: call.id, content: out };
  } catch (err) {
    event.outcome = "error";
    event.note = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool error: ${event.note}` };
  }
}
