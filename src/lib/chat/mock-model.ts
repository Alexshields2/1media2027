import type Anthropic from "@anthropic-ai/sdk";
import type { ChatModel } from "./engine";

// A scripted chat model for AGENTS_MOCK=true (local demos, previews, the e2e test and screenshots;
// never production). It looks at the last message, calls one or two of the tools it was given,
// then streams a markdown answer built from the real tool results.

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

let seq = 0;

function lastPersonText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    if (m.content.some((b) => b.type === "tool_result")) continue;
    return m.content
      .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text" && !b.text.startsWith("<context>"))
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function message(content: Block[], stop: Anthropic.Beta.BetaMessage["stop_reason"]): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_mock_${++seq}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 160, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

type Row = Record<string, unknown>;
const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const eur = (n: unknown) => `€${Number(n ?? 0).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function answerFrom(question: string, results: { name: string; content: string; isError: boolean }[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.content.startsWith("BLOCKED")) {
      lines.push(`I couldn't do that: ${r.content.replace(/^BLOCKED:\s*/, "").replace(/ Do not retry this action\.$/, "")}`);
      continue;
    }
    if (r.content.startsWith("PROPOSED")) {
      lines.push("I've proposed this for approval: **approve or reject it in the card above**. Nothing happens until someone approves it.");
      continue;
    }
    const data = parse(r.content);
    if (r.name === "OS_GET_RECEIVABLES" && data && typeof data === "object") {
      const d = data as { total?: number; clients?: Row[] };
      const clients = d.clients ?? [];
      lines.push(`## What's owed\n\n${clients.length ? `**${eur(d.total)}** is overdue across ${clients.length} client${clients.length === 1 ? "" : "s"}.` : "Nothing is overdue right now."}`);
      if (clients.length) lines.push(["| Client | Owed | Oldest |", "|---|---:|---:|", ...clients.slice(0, 8).map((c) => `| ${c.clientName} | ${eur(c.balance)} | ${c.oldestDays} days |`)].join("\n"));
    } else if (Array.isArray(data) && r.name === "OS_LIST_CLIENTS") {
      const rows = data as Row[];
      lines.push(`## Clients\n\nThere ${rows.length === 1 ? "is" : "are"} **${rows.length}** active or onboarding client${rows.length === 1 ? "" : "s"}:`);
      lines.push(["| Client | Status | CPL target |", "|---|---|---:|", ...rows.slice(0, 10).map((c) => `| ${c.name} | ${c.status} | ${c.cplTarget ? eur(c.cplTarget) : "–"} |`)].join("\n"));
    } else if (Array.isArray(data)) {
      lines.push(`Found **${data.length}** ${r.name.replace(/^OS_LIST_/, "").toLowerCase()}.`);
    } else {
      lines.push(`${r.name}: ${r.content.slice(0, 200)}`);
    }
  }
  lines.push(`\n_Mock mode: this answer was scripted from the real data for "${question.slice(0, 80)}"._`);
  return lines.join("\n\n");
}

/** The scripted model. Streams its text in small chunks so the UI behaves as it does live. */
export function mockChatModel(): ChatModel {
  return {
    async stream(params, { signal, onText }) {
      const messages = params.messages;
      const offered = new Set((params.tools ?? []).map((t) => ("name" in t ? t.name : "")));
      const question = lastPersonText(messages);
      const last = messages.at(-1);
      const results =
        last && last.role === "user" && typeof last.content !== "string" && last.content.some((b) => b.type === "tool_result")
          ? last.content.flatMap((b) => {
              if (b.type !== "tool_result") return [];
              const prev = messages.at(-2);
              const use = prev && typeof prev.content !== "string" ? prev.content.find((x) => x.type === "tool_use" && x.id === b.tool_use_id) : undefined;
              const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
              return [{ name: use && use.type === "tool_use" ? use.name : "tool", content, isError: !!b.is_error }];
            })
          : null;
      await sleep(250, signal);

      if (!results) {
        const want: [string, Record<string, unknown>][] = [];
        if (/fail/i.test(question)) throw new Error("Claude is overloaded right now (529). Try again in a minute. (mock)");
        if (/task|remind|follow.?up|todo/i.test(question) && offered.has("OS_CREATE_TASK")) want.push(["OS_CREATE_TASK", { title: question.replace(/^(please\s+)?(create|add|make)\s+(a\s+)?task\s*(to\s*)?/i, "").slice(0, 80) || "Follow up", priority: "medium" }]);
        else if (/owe|owed|payment|money|paid|overdue/i.test(question) && offered.has("OS_GET_RECEIVABLES")) want.push(["OS_GET_RECEIVABLES", {}]);
        else if (offered.has("OS_LIST_CLIENTS")) want.push(["OS_LIST_CLIENTS", {}]);
        if (want.length) {
          const intro = "Let me check the 1Media OS.";
          for (const w of intro.split(/(?<= )/)) {
            onText(w);
            await sleep(20, signal);
          }
          return message(
            [
              { type: "text", text: intro, citations: null } as Block,
              ...want.map(([name, input]) => ({ type: "tool_use", id: `toolu_mock_${++seq}`, name, input }) as Block),
            ],
            "tool_use",
          );
        }
      }

      const text = results ? answerFrom(question, results) : `Mock mode: I'm the ${String(params.system && Array.isArray(params.system) ? (params.system[0].text.match(/# Your role: (.+)/)?.[1] ?? "chat") : "chat")} agent, but no model is connected, so I can only run scripted lookups.`;
      for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
        onText(chunk);
        await sleep(12, signal);
      }
      return message([{ type: "text", text, citations: null } as Block], "end_turn");
    },
  };
}
