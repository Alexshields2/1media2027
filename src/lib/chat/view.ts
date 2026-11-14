import type { ChatAttachment, ChatMessage, ToolEvent } from "../../db/schema";

// Turns stored API messages into what the chat shows: a person's message, then one reply made of
// text and tool chips (tool results and thinking are not shown). Pure, so it is unit-tested and
// usable in the browser.

export type UiToolEvent = Pick<ToolEvent, "id" | "tool" | "outcome" | "note" | "label" | "approvalId" | "ms"> & {
  input?: unknown;
  /** Still running (live stream only). */
  running?: boolean;
  /** Approval status when the call was proposed (filled in by the page). */
  approval?: { status: string; result?: string | null };
};

export type UiPart = { type: "text"; text: string } | { type: "tool"; event: UiToolEvent };

export type UiMessage =
  | { id: string; role: "user"; text: string; attachments: ChatAttachment[] }
  | { id: string; role: "assistant"; parts: UiPart[]; stopReason?: string | null; error?: string };

/** App-added context (date, who is asking) travels in a <context> text block the chat doesn't show. */
export const CONTEXT_PREFIX = "<context>";

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };

function blocks(m: Pick<ChatMessage, "content">): Block[] {
  return Array.isArray(m.content) ? (m.content as Block[]) : [];
}

/** True for a person's message (as opposed to a user message that only carries tool results). */
export function isPersonMessage(m: Pick<ChatMessage, "role" | "content">): boolean {
  return m.role === "user" && !blocks(m).some((b) => b.type === "tool_result");
}

export function toUiMessages(rows: Pick<ChatMessage, "id" | "role" | "content" | "attachments" | "toolEvents" | "stopReason">[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const row of rows) {
    if (isPersonMessage(row)) {
      const text = blocks(row)
        .filter((b) => b.type === "text" && !b.text?.startsWith(CONTEXT_PREFIX))
        .map((b) => b.text ?? "")
        .join("\n\n");
      out.push({ id: `m${row.id}`, role: "user", text, attachments: row.attachments ?? [] });
      continue;
    }
    if (row.role === "user") continue; // tool results
    let reply = out.at(-1);
    if (!reply || reply.role !== "assistant") {
      reply = { id: `m${row.id}`, role: "assistant", parts: [] };
      out.push(reply);
    }
    const events = new Map((row.toolEvents ?? []).map((e) => [e.id, e]));
    for (const b of blocks(row)) {
      if (b.type === "text" && b.text) appendText(reply.parts, b.text);
      else if (b.type === "tool_use") {
        const e = events.get(b.id);
        reply.parts.push({ type: "tool", event: e ? uiEvent(e) : { id: b.id, tool: b.name ?? "tool", outcome: "ran", input: b.input, label: toolLabel(b.name ?? "tool", b.input) } });
      } else if (b.type === "server_tool_use") {
        reply.parts.push({ type: "tool", event: { id: b.id, tool: b.name ?? "web_search", outcome: "ran", input: b.input, label: toolLabel(b.name ?? "web_search", b.input) } });
      }
    }
    reply.stopReason = row.stopReason;
  }
  return out;
}

export function uiEvent(e: ToolEvent): UiToolEvent {
  return { id: e.id, tool: e.tool, outcome: e.outcome, note: e.note, label: e.label ?? toolLabel(e.tool, e.input), approvalId: e.approvalId, ms: e.ms, input: e.input };
}

/** Adds text to the reply, joining it to the previous text part when there's no tool call in between. */
export function appendText(parts: UiPart[], text: string) {
  const last = parts.at(-1);
  if (last?.type === "text") last.text += (last.text && !last.text.endsWith("\n") ? "\n\n" : "") + text;
  else parts.push({ type: "text", text });
}

const OS_LABELS: Record<string, string> = {
  OS_LIST_CLIENTS: "Looked up clients",
  OS_LIST_PAYMENTS: "Looked up payments",
  OS_RECORD_PAYMENT: "Record a payment",
  OS_GET_RECEIVABLES: "Checked what's owed",
  OS_QUEUE_CHASER: "Queue a payment chaser",
  OS_SAVE_CASH_SUMMARY: "Save the cash summary",
  OS_LIST_TASKS: "Looked up tasks",
  OS_CREATE_TASK: "Create a task",
  OS_SAVE_HEALTH_CHECK: "Save a health check",
  OS_SCORE_HEALTH: "Score client health",
  OS_SAVE_BRIEF: "Save a brief",
  OS_LIST_BRIEFS: "Looked up briefs",
  OS_LIST_HEALTH: "Looked up client health",
  OS_SAVE_REPORT: "Save a report",
  OS_LIST_REPORTS: "Looked up reports",
};

const TOOLKIT_NAMES: Record<string, string> = {
  GMAIL: "Gmail",
  GOOGLECALENDAR: "Calendar",
  GOOGLEDRIVE: "Drive",
  GOOGLESHEETS: "Sheets",
  GOOGLEDOCS: "Docs",
  METAADS: "Meta Ads",
  FACEBOOK: "Facebook",
  HIGHLEVEL: "HighLevel",
  STRIPE: "Stripe",
  SLACK: "Slack",
  WHATSAPP: "WhatsApp",
};

/**
 * A short label for a tool chip, e.g. "Looked up payments for Apex Attics".
 * `clientName` is the name of input.client_id when the caller knows it.
 */
export function toolLabel(tool: string, input: unknown, clientName?: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "web_search") return typeof i.query === "string" ? `Searched the web for "${i.query}"` : "Searched the web";
  if (tool === "web_fetch") return typeof i.url === "string" ? `Read ${i.url}` : "Read a web page";
  const base = OS_LABELS[tool];
  if (base) {
    const bits = [base];
    if (clientName) bits.push(`for ${clientName}`);
    else if (typeof i.client_id === "number" || typeof i.client_id === "string") bits.push(`for client #${i.client_id}`);
    if (tool === "OS_LIST_PAYMENTS" && i.filter === "outstanding") bits[0] = "Looked up outstanding payments";
    if (tool === "OS_LIST_PAYMENTS" && typeof i.month === "string") bits.push(`in ${i.month}`);
    if (tool === "OS_CREATE_TASK" && typeof i.title === "string") bits.push(`– ${i.title}`);
    return bits.join(" ");
  }
  const [kit, ...rest] = tool.split("_");
  const app = TOOLKIT_NAMES[kit] ?? kit.charAt(0) + kit.slice(1).toLowerCase();
  const action = rest.join(" ").toLowerCase();
  return `${app}: ${action || tool.toLowerCase()}`;
}

/** A conversation title from the first message: its first line, cut at a word boundary. */
export function titleFrom(text: string, fallback = "New chat"): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
