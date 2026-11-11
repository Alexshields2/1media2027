import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { ExternalTools, ModelClient, RunDeps } from "./runner";
import { FIXTURE_TOOL_DEFS, ghlContacts, metaInsights, metaLeadCount, type GhlContact, type MetaInsightRow } from "./fixtures/ads-fixtures";
import { deriveMetrics, sumMetrics } from "./report-metrics";
import { eur, monthLabel } from "./dates";

// A scripted stand-in for the model and for Meta Ads / GoHighLevel, used by tests and by
// AGENTS_MOCK=true (local demos, previews). It follows the same tool protocol as the real
// agent: read the client, read Meta and GHL, read tasks, save the report with its numbers.
// Never used in production (see mockModeEnabled in runner.ts).

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

interface ToolResult {
  name: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}

/** Fixture Meta Ads + GHL tools. Pass `fail` to make specific calls throw (retry tests). */
export function fixtureTools(opts: { fail?: (name: string, input: Record<string, unknown>) => string | undefined } = {}): ExternalTools {
  return {
    defs: FIXTURE_TOOL_DEFS,
    async execute(name, input) {
      const failure = opts.fail?.(name, input);
      if (failure) throw new Error(failure);
      if (name === "METAADS_GET_INSIGHTS") {
        const tr = input.time_range as { since: string; until: string };
        return JSON.stringify(metaInsights(String(input.ad_account_id), tr.since, tr.until));
      }
      if (name === "HIGHLEVEL_LIST_CONTACTS") {
        const loc = String(input.location_id);
        const start = String(input.start_date);
        const end = String(input.end_date);
        // GHL holds the same leads Meta counted, so the fixture returns a matching number.
        const [client] = await db.select().from(schema.clients).where(eq(schema.clients.ghlLocationId, loc)).limit(1);
        const accounts = splitIds(client?.metaAdAccountIds);
        const count = accounts.reduce((n, a) => n + metaLeadCount(metaInsights(a, start, end).data), 0);
        return JSON.stringify(ghlContacts(loc, start, end, count));
      }
      throw new Error(`No fixture for tool ${name}`);
    },
  };
}

export function mockDeps(): RunDeps {
  return { model: scriptedModel(), external: fixtureTools() };
}

export function splitIds(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function textOf(content: Msg["content"]): string {
  return typeof content === "string" ? content : content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** Every tool call in the transcript with its result, oldest first. */
function allResults(messages: Msg[]): ToolResult[][] {
  const turns: ToolResult[][] = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (prev.role !== "assistant" || cur.role !== "user" || typeof prev.content === "string" || typeof cur.content === "string") continue;
    const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const b of prev.content) if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input as Record<string, unknown> });
    const out: ToolResult[] = [];
    for (const b of cur.content) {
      if (b.type !== "tool_result") continue;
      const use = uses.get(b.tool_use_id);
      const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
      if (use) out.push({ ...use, content, isError: !!b.is_error });
    }
    turns.push(out);
  }
  return turns;
}

let seq = 0;
function reply(content: Block[], stop: "tool_use" | "end_turn"): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_mock_${++seq}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}
const say = (text: string) => reply([{ type: "text", text, citations: null } as Block], "end_turn");
const call = (...tools: [string, Record<string, unknown>][]) =>
  reply(
    tools.map(([name, input]) => ({ type: "tool_use", id: `toolu_mock_${++seq}`, name, input }) as Block),
    "tool_use",
  );

/** The scripted "model". Works out which agent it is from the system prompt and the step from the transcript. */
export function scriptedModel(): ModelClient {
  return {
    async create(params) {
      const system = Array.isArray(params.system) ? params.system.map((b) => b.text).join("\n") : String(params.system ?? "");
      const task = textOf(params.messages[0].content);
      const step = params.messages.filter((m) => m.role === "assistant").length;
      const turns = allResults(params.messages);
      const results = turns.at(-1) ?? [];
      const everything = turns.flat();
      if (system.includes("# Your role: weekly-report")) return weeklyStep(task, step, results, everything);
      if (system.includes("# Your role: month-end-report")) return monthlyStep(task, step, results);
      return say("Mock mode: this agent has no scripted behaviour. Nothing was done.");
    },
  };
}

type ClientRow = typeof schema.clients.$inferSelect;

function clientFrom(results: ToolResult[], id: number): ClientRow | undefined {
  const r = results.find((x) => x.name === "OS_LIST_CLIENTS");
  if (!r || r.isError) return undefined;
  return (JSON.parse(r.content) as ClientRow[]).find((c) => c.id === id);
}

function fmtPhone(p: string): string {
  const d = p.replace(/[^\d]/g, "").replace(/^353/, "");
  return `+353 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}`;
}

function weeklyStep(task: string, step: number, results: ToolResult[], everything: ToolResult[]) {
  const clientId = Number(task.match(/client_id=(\d+)/)?.[1]);
  const [, start, end] = task.match(/Reporting week: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/) ?? [];
  if (!clientId || !start) return say("Mock weekly agent only supports per-client runs.");

  if (step === 0) return call(["OS_LIST_CLIENTS", { include_inactive: true }]);

  if (step === 1) {
    const c = clientFrom(results, clientId);
    if (!c) return say(`Client ${clientId} not found. No report saved.`);
    const accounts = splitIds(c.metaAdAccountIds);
    if (!accounts.length) return say(`Skipped ${c.name}: no Meta ad account on the client record. No report saved.`);
    return call(
      ...accounts.map((a): [string, Record<string, unknown>] => ["METAADS_GET_INSIGHTS", { ad_account_id: a, time_range: { since: start, until: end } }]),
      ...(c.ghlLocationId ? [["HIGHLEVEL_LIST_CONTACTS", { location_id: c.ghlLocationId, start_date: start, end_date: end }] as [string, Record<string, unknown>]] : []),
      ["OS_LIST_TASKS", { client_id: clientId, status: "all" }],
    );
  }

  if (step === 2) {
    const failed = results.filter((r) => r.isError);
    if (failed.length) return say(`Could not finish: ${failed.map((f) => `${f.name}: ${f.content}`).join("; ")}. No report saved.`);
    const c = clientFrom(everything, clientId)!;
    const rows: MetaInsightRow[] = results.filter((r) => r.name === "METAADS_GET_INSIGHTS").flatMap((r) => (JSON.parse(r.content) as { data: MetaInsightRow[] }).data);
    const spend = rows.reduce((n, r) => n + Number(r.spend), 0);
    const impressions = rows.reduce((n, r) => n + Number(r.impressions), 0);
    const clicks = rows.reduce((n, r) => n + Number(r.inline_link_clicks), 0);
    const leads = metaLeadCount(rows);
    const ghl = results.find((r) => r.name === "HIGHLEVEL_LIST_CONTACTS");
    const contacts: GhlContact[] = ghl ? (JSON.parse(ghl.content) as { contacts: GhlContact[] }).contacts : [];
    const tasks = JSON.parse(results.find((r) => r.name === "OS_LIST_TASKS")?.content ?? "[]") as { title: string; status: string; completedAt: string | null }[];
    const m = deriveMetrics({ spend, leads, impressions, clicks });
    const body = weeklyBody({ client: c, m, contacts, tasks, start });
    return call(["OS_SAVE_REPORT", { client_id: clientId, kind: "weekly", period: start, body, spend: m.spend, leads: m.leads, impressions: m.impressions, clicks: m.clicks }]);
  }

  const saved = results.find((r) => r.name === "OS_SAVE_REPORT");
  return say(saved && !saved.isError ? `Weekly report saved for client ${clientId}. ${saved.content}` : `Report not saved: ${saved?.content ?? "unknown"}`);
}

function weeklyBody(a: { client: ClientRow; m: ReturnType<typeof deriveMetrics>; contacts: GhlContact[]; tasks: { title: string; status: string; completedAt: string | null }[]; start: string }) {
  const greeting = a.client.reportGreeting || "Hi guys";
  const currency = a.client.reportCurrency;
  const noLeads = /not list leads|no lead list/i.test(a.client.reportRules ?? "");
  const money = (n: number | null) => eur(n, currency);
  const lines = [
    `${greeting}, this is how we got on last week.`,
    "",
    `Leads: ${a.m.leads}`,
    `Amount spent: ${money(a.m.spend)}`,
    `Cost per lead: ${money(a.m.cpl)}`,
    `Impressions: ${a.m.impressions?.toLocaleString("en-IE")}`,
    `Link clicks: ${a.m.clicks?.toLocaleString("en-IE")}`,
  ];
  if (!noLeads && a.contacts.length) {
    lines.push("", "Here are your leads:", "");
    for (const c of a.contacts) {
      const f = (k: string) => c.customFields.find((x) => x.key === k)?.value;
      lines.push(`${c.firstName} ${c.lastName} ${fmtPhone(c.phone)}`, c.city, c.postalCode, f("timeframe") ?? "", f("budget") ?? "", f("project") ?? "", c.email);
      if (c.tags.includes("high intent")) lines.push("High Intent");
      lines.push("");
    }
    lines.pop();
  }
  lines.push("", "A steady week. We'll keep testing new creative and push budget towards the best performing ad.");
  const done = a.tasks.filter((t) => t.status === "done" && t.completedAt && t.completedAt.slice(0, 10) >= a.start);
  const open = a.tasks.filter((t) => t.status !== "done");
  if (done.length) lines.push("", "What we got done this week:", ...done.map((t) => t.title));
  if (open.length) lines.push("", "Still to do:", ...open.map((t) => t.title), "We will get these ticked off today.");
  lines.push("", "Jamie");
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

function monthlyStep(task: string, step: number, results: ToolResult[]) {
  const clientId = Number(task.match(/client_id=(\d+)/)?.[1]);
  const month = task.match(/period_prefix "(\d{4}-\d{2})"/)?.[1];
  if (!clientId || !month) return say("Mock month-end agent only supports per-client runs.");
  if (step === 0) return call(["OS_LIST_CLIENTS", { include_inactive: true }], ["OS_LIST_REPORTS", { client_id: clientId, kind: "weekly", period_prefix: month }]);
  if (step === 1) {
    const c = clientFrom(results, clientId);
    const weeks = JSON.parse(results.find((r) => r.name === "OS_LIST_REPORTS")?.content ?? "[]") as { period: string; spend: number | null; leads: number | null; impressions: number | null; clicks: number | null }[];
    if (!c) return say(`Client ${clientId} not found. No report saved.`);
    if (!weeks.length) return say(`No weekly reports for ${c.name} in ${month}. No report saved.`);
    const t = sumMetrics(weeks);
    const money = (n: number | null) => eur(n, c.reportCurrency);
    const target = c.cplTarget ? ` against a target of ${money(c.cplTarget)}` : "";
    const body = [
      `# ${c.name.toUpperCase()}`,
      "Monthly Digital Marketing Performance Report",
      `Reporting Period: ${monthLabel(`${month}-01`)}`,
      "Prepared by: 1Media",
      "",
      "## Executive Summary",
      `${monthLabel(`${month}-01`)} delivered ${t.leads} leads from ${money(t.spend)} of ad spend, a cost per lead of ${money(t.cpl)}${target}. Campaigns ran across ${weeks.length} reporting weeks with steady delivery.`,
      "",
      "## Performance Snapshot",
      `- **Leads:** ${t.leads}`,
      `- **Amount spent:** ${money(t.spend)}`,
      `- **Cost per lead:** ${money(t.cpl)}`,
      `- **Impressions:** ${t.impressions?.toLocaleString("en-IE")}`,
      `- **Link clicks:** ${t.clicks?.toLocaleString("en-IE")}`,
      `- **Click-through rate:** ${t.ctr}%`,
      "",
      "## Work Completed This Month",
      "### Paid Advertising",
      "- Weekly optimisation of budgets and audiences",
      "- New creative tested against the best performing ad",
      "",
      "## Key Wins",
      `- ${t.leads} new enquiries delivered into the CRM`,
      "",
      "## Recommendations",
      "- Keep budget on the best performing campaign and refresh creative every three weeks to hold cost per lead.",
      "",
      "## Next Month Action Plan",
      "- Launch two new ad angles and review lead follow-up in the CRM together.",
      "",
      "## Month-End Summary",
      "Thanks for another month working together. We're happy with the direction and will keep pushing on cost per lead and volume.",
    ].join("\n");
    return call(["OS_SAVE_REPORT", { client_id: clientId, kind: "monthly", period: month, body, spend: t.spend, leads: t.leads, impressions: t.impressions, clicks: t.clicks }]);
  }
  const saved = results.find((r) => r.name === "OS_SAVE_REPORT");
  return say(saved && !saved.isError ? `Month-end report saved for client ${clientId}.` : `Report not saved: ${saved?.content ?? "unknown"}`);
}
