import type Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "../db";
import type { ToolEvent } from "../db/schema";
import { decide, type Autonomy, type Decision } from "./guardrails";
import { isOsTool, runOsTool } from "./os-tools";

// One tool call from the model, run through the guardrails. Shared by the agent runner
// (src/lib/runner.ts) and the chat engine (src/lib/chat/engine.ts) so both decide the same way.

/** External (non-OS) tools: Composio in production, fixtures in tests. */
export interface ExternalTools {
  defs: Anthropic.Beta.BetaToolUnion[];
  execute(name: string, input: Record<string, unknown>, callId: string): Promise<string>;
}

export interface ToolCallPolicy {
  /** Name saved on approvals and audit rows (the code agent's name, or the chat profile's slug). */
  agent: string;
  autonomy: Autonomy;
  /** Write tools allowed to run although the autonomy level would propose them. */
  allow?: string[];
  /** Tools this agent must never call (regexes on the slug). */
  excludeTools?: RegExp[];
  /** Extra per-caller block, e.g. money tools for a team member. Returns a reason to block, or undefined. */
  extraBlock?: (tool: string) => string | undefined;
}

/** True when the agent definition forbids this tool (it is neither offered nor run). */
export function isExcluded(agent: { excludeTools?: RegExp[] }, name: string): boolean {
  return (agent.excludeTools ?? []).some((re) => re.test(name.toUpperCase()));
}

/** What the guardrails say about one call, including exclusions and caller-specific blocks. */
export function decideCall(name: string, policy: ToolCallPolicy): Decision {
  if (isExcluded(policy, name)) return { action: "block", reason: `${policy.agent} may not use ${name}.` };
  const extra = policy.extraBlock?.(name);
  if (extra) return { action: "block", reason: extra };
  return decide(name, policy.autonomy, policy.allow);
}

/**
 * Runs (or blocks, or queues for approval) one tool call and returns the tool_result block.
 * Pushes a ToolEvent onto `events` and updates it in place as the call finishes.
 */
export async function handleToolCall(
  call: Pick<Anthropic.Beta.BetaToolUseBlock, "id" | "name" | "input">,
  policy: ToolCallPolicy,
  opts: {
    runId?: number | null;
    turn: number;
    events: ToolEvent[];
    external: ExternalTools;
    label?: string;
    /** Rewrites a tool's output before the model sees it (e.g. hiding billing fields from team members). */
    transform?: (tool: string, out: string) => string;
  },
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const d = decideCall(call.name, policy);
  const started = Date.now();
  const event: ToolEvent = { id: call.id, tool: call.name, input, outcome: "ran", turn: opts.turn, at: new Date(started).toISOString() };
  if (opts.label) event.label = opts.label;
  opts.events.push(event);

  if (d.action === "block") {
    event.outcome = "blocked";
    event.note = d.reason;
    return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `BLOCKED: ${d.reason} Do not retry this action.` };
  }

  if (d.action === "propose") {
    event.outcome = "proposed";
    event.note = d.reason;
    const [a] = await db
      .insert(schema.approvals)
      .values({ runId: opts.runId ?? null, agent: policy.agent, tool: call.name, input, reason: d.reason })
      .returning({ id: schema.approvals.id });
    event.approvalId = a.id;
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `PROPOSED (not executed): ${d.reason} It is queued in the 1Media OS approvals page. Continue as if it will be done, and list it in your summary.`,
    };
  }

  try {
    const raw = isOsTool(call.name)
      ? await runOsTool(call.name, input, { runId: opts.runId ?? undefined, agent: policy.agent })
      : await opts.external.execute(call.name, input, call.id);
    const out = opts.transform ? opts.transform(call.name, raw) : raw;
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
