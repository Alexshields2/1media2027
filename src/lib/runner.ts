import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AnthropicToolUseBlock } from "@composio/anthropic";
import { MODEL, config, requireEnv } from "../config.js";
import { composio, loadTools } from "./composio.js";
import { decide, type Autonomy } from "./guardrails.js";
import { notionMap } from "./notion.js";
import { newRun, saveRun, type RunRecord, type ToolEvent } from "./runlog.js";
import type { AgentDefinition, AgentContext } from "../agents/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadPrompt(file: string): string {
  return readFileSync(path.join(here, "..", file), "utf8");
}

/** Shared house rules + the agent's own prompt + the Notion map. Kept stable so it caches. */
function systemPrompt(agent: AgentDefinition, autonomy: Autonomy): string {
  const house = loadPrompt("agents/house-rules.md");
  const own = loadPrompt(`agents/${agent.name}/prompt.md`);
  return [
    house,
    `# Your role: ${agent.name}\n\n${own}`,
    `# Where things live\n\n${notionMap()}`,
    `# Your autonomy level: ${autonomy}\n\nWrite actions you are not cleared for come back as "PROPOSED" or "BLOCKED" instead of running. That is expected: carry on, and list every proposed action in your final summary so a human can approve it.`,
  ].join("\n\n---\n\n");
}

export interface RunOptions {
  dryRun?: boolean;
  instruction?: string;
}

export async function runAgent(agent: AgentDefinition, opts: RunOptions = {}): Promise<RunRecord> {
  requireEnv("ANTHROPIC_API_KEY");
  const autonomy: Autonomy = opts.dryRun ? "L0" : agent.autonomy;
  const ctx: AgentContext = {
    today: new Date().toLocaleDateString("en-CA", { timeZone: config.timezone }),
    instruction: opts.instruction,
  };
  const task = agent.task(ctx) + (ctx.instruction ? `\n\nExtra instruction for this run: ${ctx.instruction}` : "");
  const run = newRun(agent.name, task, !!opts.dryRun);

  const client = new Anthropic();
  const tools = await loadTools({ toolkits: agent.toolkits, tools: agent.tools });
  const system = systemPrompt(agent, autonomy);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task }];

  for (let turn = 0; turn < agent.maxTurns; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: tools as Anthropic.Beta.BetaToolUnion[],
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: agent.effort },
      // If a safety classifier declines, the server retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    run.usage.inputTokens += res.usage.input_tokens;
    run.usage.outputTokens += res.usage.output_tokens;
    run.usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    run.stopReason = res.stop_reason ?? undefined;

    if (res.stop_reason === "refusal") {
      run.summary = "Run stopped: the model declined this request.";
      break;
    }

    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason !== "tool_use") {
      run.summary = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    const calls = res.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    // Run the calls in parallel, then return every result in a single user message.
    const results = await Promise.all(calls.map((call) => handleCall(call, agent, autonomy, run)));
    messages.push({ role: "user", content: results });
  }

  if (run.summary === undefined) {
    run.summary = `Run stopped after ${agent.maxTurns} turns without finishing.`;
  }
  run.finishedAt = new Date().toISOString();
  saveRun(run);
  return run;
}

async function handleCall(
  call: Anthropic.Beta.BetaToolUseBlock,
  agent: AgentDefinition,
  autonomy: Autonomy,
  run: RunRecord,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const d = decide(call.name, autonomy, agent.allow);
  const event: ToolEvent = { tool: call.name, input: call.input, outcome: "ran" };
  run.events.push(event);

  if (d.action === "block") {
    event.outcome = "blocked";
    event.note = d.reason;
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `BLOCKED: ${d.reason} Do not retry this action.` };
  }
  if (d.action === "propose") {
    event.outcome = "proposed";
    event.note = d.reason;
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `PROPOSED (not executed): ${d.reason} It has been queued for human approval. Continue as if it will be done, and list it in your summary.`,
    };
  }

  try {
    const toolUse: AnthropicToolUseBlock = {
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: (call.input ?? {}) as Record<string, unknown>,
    };
    const out = await composio().provider.executeToolCall(config.composioUserId, toolUse);
    event.result = out.length > 2000 ? out.slice(0, 2000) + "…[truncated in log only]" : out;
    return { type: "tool_result", tool_use_id: call.id, content: out };
  } catch (err) {
    event.outcome = "error";
    event.note = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool error: ${event.note}` };
  }
}
