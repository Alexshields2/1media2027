import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolUseBlock } from "@composio/anthropic";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { MODEL, config } from "../../config";
import { db, schema } from "../../db";
import type { AgentProfile, Conversation, ToolEvent } from "../../db/schema";
import { AGENTS } from "../../agents/registry";
import { composio, loadComposioTools, composioEnabled, type ToolkitSlug } from "../composio";
import { osToolDefs } from "../os-tools";
import { describeError, mockModeEnabled } from "../runner";
import { chatAutonomyNote, assembleSystemPrompt } from "../prompt";
import { handleToolCall, isExcluded, type ExternalTools, type ToolCallPolicy } from "../tool-call";
import { rejectIfPending } from "../approvals";
import { audit } from "../audit";
import type { Role } from "../roles";
import { canUseProfile, ownsConversation, osToolsFor, redactToolResult, toolAllowedForRole, toolkitsFor } from "./access";
import { toContentBlocks, type IncomingFile } from "./attachments";
import { CONTEXT_PREFIX, isPersonMessage, titleFrom, toolLabel, uiEvent, type UiToolEvent } from "./view";

// The chat engine: one person message in, a streamed reply out. It runs the same tool loop and
// guardrails as scheduled runs (src/lib/tool-call.ts) and saves every API message, so replaying
// the rows rebuilds the conversation exactly (thinking and web search blocks included).

type Msg = Anthropic.Beta.BetaMessageParam;
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** One streamed Messages API call: onText gets each text delta; resolves with the final message. */
export interface ChatModel {
  stream(params: Params, opts: { signal?: AbortSignal; onText: (delta: string) => void }): Promise<Anthropic.Beta.BetaMessage>;
}

/** What the browser receives, one JSON object per line. */
export type ChatEvent =
  | { type: "conversation"; id: number; title: string; created: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; event: UiToolEvent }
  | { type: "notice"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; stopReason: string | null };

export interface ChatUser {
  id: number;
  name: string;
  role: Role;
}

export interface ChatTurnInput {
  user: ChatUser;
  profile: AgentProfile;
  conversationId?: number | null;
  text?: string;
  files?: IncomingFile[];
  /** Drop the last reply and answer the last message again. */
  regenerate?: boolean;
}

export interface ChatDeps {
  model?: ChatModel;
  external?: ExternalTools;
  signal?: AbortSignal;
  /** Epoch ms: no new model call starts after this (Vercel stops the function at 300 s). */
  deadline?: number;
  /** Epoch ms: an in-flight model call is cut off at this point. */
  hardDeadline?: number;
}

export const NO_KEY_MESSAGE = "This agent can't answer yet: ANTHROPIC_API_KEY isn't set. Add it in Vercel → Settings → Environment Variables, then redeploy.";

/** Thrown for anything the person did wrong (shown as-is, not as a server error). */
export class ChatInputError extends Error {}

function realModel(): ChatModel {
  const client = new Anthropic();
  return {
    async stream(params, { signal, onText }) {
      const s = client.beta.messages.stream(params, { signal });
      s.on("text", (delta) => onText(delta));
      return s.finalMessage();
    },
  };
}

async function pickModel(deps: ChatDeps): Promise<ChatModel | null> {
  if (deps.model) return deps.model;
  if (process.env.ANTHROPIC_API_KEY) return realModel();
  if (mockModeEnabled()) return (await import("./mock-model")).mockChatModel();
  return null;
}

/** The system prompt for a chat agent: house rules + the owner's instructions + the autonomy note. No dates: it caches. */
export function chatSystemPrompt(profile: Pick<AgentProfile, "name" | "instructions" | "autonomy">): string {
  return assembleSystemPrompt(profile.name, profile.instructions.trim() || "Help the person with whatever they ask, using the tools you have.", chatAutonomyNote(profile.autonomy));
}

/** The app-added context block for a person's message (date, who is asking). Saved with the message so history replays exactly. */
export function contextBlock(user: ChatUser, now = new Date()): string {
  const date = now.toLocaleDateString("en-IE", { timeZone: config.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const iso = now.toLocaleDateString("sv-SE", { timeZone: config.timezone });
  return `${CONTEXT_PREFIX}Today is ${date} (${iso}, Europe/Dublin). Asking: ${user.name} (${user.role}).</context>`;
}

function baseAgent(profile: AgentProfile) {
  return profile.baseAgent ? AGENTS[profile.baseAgent] : undefined;
}

/** Composio tools for this profile and person, minus excluded and money tools. */
async function composioTools(profile: AgentProfile, role: Role): Promise<ExternalTools> {
  const base = baseAgent(profile);
  const toolkits = toolkitsFor(role, profile) as ToolkitSlug[];
  const defs = toolkits.length
    ? ((await loadComposioTools({ toolkits })).filter((t) => !isExcluded({ excludeTools: base?.excludeTools }, t.name) && toolAllowedForRole(role, t.name)) as Anthropic.Beta.BetaToolUnion[])
    : [];
  return {
    defs,
    execute: (name, input, callId) => {
      const toolUse: AnthropicToolUseBlock = { type: "tool_use", id: callId, name, input };
      return composio().provider.executeToolCall(config.composioUserId, toolUse);
    },
  };
}

/** The tool list for one chat: OS tools, connected apps, and web search when on. Order is stable so it caches. */
export function chatTools(profile: AgentProfile, role: Role, external: ExternalTools): Anthropic.Beta.BetaToolUnion[] {
  // OS tools validate their input with zod (runOsTool), so their input can stream eagerly.
  const os = osToolDefs(osToolsFor(role, profile)).map((t) => ({ ...t, eager_input_streaming: true }));
  const web: Anthropic.Beta.BetaToolUnion[] = profile.webSearch ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] : [];
  return [...os, ...external.defs, ...web] as Anthropic.Beta.BetaToolUnion[];
}

function toolNames(tools: Anthropic.Beta.BetaToolUnion[]): Set<string> {
  return new Set(tools.map((t) => ("name" in t ? t.name : "")).filter(Boolean));
}

/** Guardrails for a chat: the profile's autonomy, the base agent's allow/exclude lists, plus per-person blocks. */
export function chatPolicy(profile: AgentProfile, role: Role, offered: Set<string>): ToolCallPolicy {
  const base = baseAgent(profile);
  return {
    agent: profile.slug,
    autonomy: profile.autonomy,
    allow: base?.allow,
    excludeTools: base?.excludeTools,
    extraBlock: (tool) => {
      if (!toolAllowedForRole(role, tool)) return "Team members can't use money tools.";
      if (!offered.has(tool)) return `${tool} isn't one of this agent's tools.`;
      return undefined;
    },
  };
}

/** Removes tool calls the model didn't finish (cut off or declined), so the saved history stays valid. */
function withoutDanglingToolUse(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  return content.filter((b) => b.type !== "tool_use");
}

async function loadConversation(user: ChatUser, profile: AgentProfile, id: number): Promise<Conversation> {
  const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  if (!c || !ownsConversation(user, c) || c.agentProfileId !== profile.id) throw new ChatInputError("That conversation doesn't exist.");
  return c;
}

/** Deletes everything after the last person message (and rejects approvals the dropped reply proposed). */
async function dropLastReply(conversationId: number): Promise<void> {
  const rows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.conversationId, conversationId)).orderBy(asc(schema.chatMessages.id));
  const last = rows.findLastIndex((r) => isPersonMessage(r));
  if (last < 0) throw new ChatInputError("There's nothing to regenerate yet.");
  const dropped = rows.slice(last + 1);
  if (!dropped.length) return;
  for (const e of dropped.flatMap((r) => r.toolEvents ?? [])) if (e.approvalId) await rejectIfPending(e.approvalId);
  await db.delete(schema.chatMessages).where(and(eq(schema.chatMessages.conversationId, conversationId), gt(schema.chatMessages.id, rows[last].id)));
}

/**
 * Runs one chat turn: saves the person's message, calls the model in a loop with tools,
 * streams text and tool events through `emit`, and saves every message.
 */
export async function runChatTurn(input: ChatTurnInput, emit: (e: ChatEvent) => void, deps: ChatDeps = {}): Promise<void> {
  const { user, profile } = input;
  const role = user.role;
  let stopReason: string | null = null;
  try {
    if (!canUseProfile(role, profile)) throw new ChatInputError(`You can't use the ${profile.name} agent. Ask an owner.`);
    const model = await pickModel(deps);
    if (!model) throw new ChatInputError(NO_KEY_MESSAGE);

    // 1. The conversation and the person's message.
    const text = (input.text ?? "").trim().slice(0, 20000);
    let conversation: Conversation;
    let created = false;
    if (input.conversationId) {
      conversation = await loadConversation(user, profile, input.conversationId);
    } else {
      if (input.regenerate) throw new ChatInputError("There's nothing to regenerate yet.");
      [conversation] = await db
        .insert(schema.conversations)
        .values({ agentProfileId: profile.id, userId: user.id, title: titleFrom(text || input.files?.[0]?.name || "") })
        .returning();
      created = true;
      await audit("agent.ask", { userId: user.id, target: `conversation:${conversation.id}`, detail: { agent: profile.slug } });
    }
    emit({ type: "conversation", id: conversation.id, title: conversation.title, created });

    if (input.regenerate) {
      await dropLastReply(conversation.id);
    } else {
      const files = input.files ?? [];
      if (!text && !files.length) throw new ChatInputError("Type a message first.");
      const att = toContentBlocks(files);
      if (!att.ok) throw new ChatInputError(att.error);
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        ...att.blocks,
        { type: "text", text: text || "(See the attached file.)" },
        { type: "text", text: contextBlock(user) },
      ];
      await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "user", content, attachments: att.attachments });
    }

    // 2. History, tools and guardrails.
    const rows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.conversationId, conversation.id)).orderBy(asc(schema.chatMessages.id));
    const messages: Msg[] = rows.map((r) => ({ role: r.role, content: r.content as Anthropic.Beta.BetaContentBlockParam[] }));
    const external = deps.external ?? (mockModeEnabled() && !process.env.ANTHROPIC_API_KEY ? { defs: [], execute: async () => "{}" } : await composioTools(profile, role));
    const tools = chatTools(profile, role, external);
    const policy = chatPolicy(profile, role, toolNames(tools));
    const base = baseAgent(profile);
    const system = chatSystemPrompt(profile);
    const note =
      profile.toolkits.length && !external.defs.length && !composioEnabled()
        ? " External apps (Gmail, Meta Ads, HighLevel, Stripe…) aren't connected yet, so this chat can only use the 1Media OS database."
        : "";
    if (note && rows.length <= 1) emit({ type: "notice", text: note.trim() });

    let clientNames: Map<number, string> | undefined;
    const nameOf = async (input: unknown) => {
      const id = Number((input as { client_id?: unknown } | null)?.client_id);
      if (!id) return undefined;
      clientNames ??= new Map((await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients)).map((c) => [c.id, c.name]));
      return clientNames.get(id);
    };

    // 3. The loop.
    const maxTurns = Math.min(base?.maxTurns ?? 30, 40);
    let finished = false;
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (deps.signal?.aborted) {
        stopReason = "stopped";
        finished = true;
        break;
      }
      if (deps.deadline && Date.now() > deps.deadline) {
        emit({ type: "notice", text: "Stopped: this reply hit the time limit. Send “continue” to carry on." });
        stopReason = "time_limit";
        finished = true;
        break;
      }

      const signals = [deps.signal, deps.hardDeadline ? AbortSignal.timeout(Math.max(1000, deps.hardDeadline - Date.now())) : undefined].filter(Boolean) as AbortSignal[];
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      let partial = "";
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await model.stream(
          {
            model: MODEL,
            max_tokens: 32000,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: base?.effort === "xhigh" ? "high" : (base?.effort ?? "medium") },
            // Caches the conversation so far, so each turn only pays for what's new.
            cache_control: { type: "ephemeral" },
            // If a safety classifier declines, the server retries on a fallback model.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          {
            signal,
            onText: (d) => {
              partial += d;
              emit({ type: "text", text: d });
            },
          },
        );
      } catch (err) {
        if (signal?.aborted) {
          // Stopped by the person (or the time limit): keep what was already shown.
          if (partial.trim()) {
            await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: [{ type: "text", text: partial }], stopReason: "stopped" });
          }
          const timedOut = !deps.signal?.aborted;
          if (timedOut) emit({ type: "notice", text: "Stopped: this reply hit the time limit. Send “continue” to carry on." });
          stopReason = timedOut ? "time_limit" : "stopped";
          finished = true;
          break;
        }
        throw err;
      }

      const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0 };
      stopReason = res.stop_reason;
      const calls = res.stop_reason === "tool_use" ? res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use") : [];
      // A cut-off or declined turn can end in a half-written tool call: never run it, and don't save it.
      const content = res.stop_reason === "tool_use" ? res.content : withoutDanglingToolUse(res.content);
      const [assistantRow] = await db
        .insert(schema.chatMessages)
        .values({ conversationId: conversation.id, role: "assistant", content, stopReason: res.stop_reason, ...usage })
        .returning({ id: schema.chatMessages.id });
      messages.push({ role: "assistant", content });

      for (const b of res.content) {
        if (b.type === "server_tool_use") emit({ type: "tool", event: { id: b.id, tool: b.name, outcome: "ran", input: b.input, label: toolLabel(b.name, b.input) } });
      }

      if (res.stop_reason === "refusal") {
        emit({ type: "notice", text: "The model declined this request." });
        finished = true;
        break;
      }
      if (res.stop_reason === "pause_turn") continue; // a long server-side tool turn: carry on where it left off
      if (res.stop_reason === "max_tokens") {
        emit({ type: "notice", text: "The reply was cut off at the length limit." });
        finished = true;
        break;
      }
      if (!calls.length) {
        finished = true;
        break;
      }

      // Run the calls in parallel, then return every result in one user message.
      const events: ToolEvent[] = [];
      const results = await Promise.all(
        calls.map(async (c) => {
          const label = toolLabel(c.name, c.input, await nameOf(c.input));
          emit({ type: "tool", event: { id: c.id, tool: c.name, outcome: "ran", label, input: c.input, running: true } });
          const r = await handleToolCall(c, policy, { turn, events, external, label, transform: (tool, out) => redactToolResult(role, tool, out) });
          const e = events.find((x) => x.id === c.id);
          if (e) emit({ type: "tool", event: uiEvent(e) });
          return r;
        }),
      );
      await db.update(schema.chatMessages).set({ toolEvents: events }).where(eq(schema.chatMessages.id, assistantRow.id));
      await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "user", content: results });
      messages.push({ role: "user", content: results });
    }
    if (!finished) emit({ type: "notice", text: `Stopped after ${maxTurns} steps without finishing. Send “continue” to carry on.` });

    await db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, conversation.id));
    emit({ type: "done", stopReason });
  } catch (err) {
    if (!(err instanceof ChatInputError)) console.error("chat turn failed", err);
    emit({ type: "error", message: err instanceof ChatInputError ? err.message : describeError(err) });
    emit({ type: "done", stopReason: "error" });
  }
}

/** Approval statuses for the proposed calls in a conversation (for the inline approval cards). */
export async function approvalStatuses(ids: number[]): Promise<Map<number, { status: string; result: string | null }>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: schema.approvals.id, status: schema.approvals.status, result: schema.approvals.result }).from(schema.approvals).where(inArray(schema.approvals.id, ids));
  return new Map(rows.map((r) => [r.id, { status: r.status, result: r.result }]));
}
