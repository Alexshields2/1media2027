import { test } from "node:test";
import assert from "node:assert/strict";
import { houseRules } from "../src/agents/house-rules";
import { AGENTS } from "../src/agents/registry";
import { chatSystemPrompt, chatTools, chatPolicy, contextBlock } from "../src/lib/chat/engine";
import { DEFAULT_PROFILES, DEFAULT_BY_SLUG, slugify } from "../src/lib/chat/profiles";
import { canEditProfiles, canSeeProfile, canUseProfile, osToolsFor, ownsConversation, redactToolResult, toolAllowedForRole, toolkitsFor } from "../src/lib/chat/access";
import { toContentBlocks, MAX_TOTAL_BYTES, mediaTypeOf } from "../src/lib/chat/attachments";
import { readXlsx, xlsxToText } from "../src/lib/chat/xlsx";
import { titleFrom, toolLabel, toUiMessages } from "../src/lib/chat/view";
import { decideCall } from "../src/lib/tool-call";
import { isMoneyTool, MONEY_OS_TOOLS } from "../src/lib/roles";
import type { AgentProfile } from "../src/db/schema";

const profile = (slug: string, over: Partial<AgentProfile> = {}): AgentProfile => ({ ...DEFAULT_BY_SLUG[slug], id: 1, createdAt: new Date(0), updatedAt: new Date(0), ...over });
const noExternal = { defs: [], execute: async () => "" };

// ---------- prompt assembly ----------

test("system prompt = house rules + the owner's instructions + the autonomy note", () => {
  const p = chatSystemPrompt({ name: "Payments", instructions: "Chase every euro.\n", autonomy: "L1" });
  assert.ok(p.startsWith(houseRules), "house rules come first");
  assert.match(p, /# Your role: Payments\n\nChase every euro\./);
  assert.match(p, /# Your autonomy level: L1 \(drafts\)/);
  assert.match(p, /This is a chat/);
  // Order: rules, role, autonomy.
  assert.ok(p.indexOf("# Your role") < p.indexOf("# Your autonomy level"));
});

test("system prompt is stable for caching: no dates or per-person details", () => {
  const prof = { name: "Jarvis", instructions: AGENTS.jarvis.prompt, autonomy: "L0" as const };
  assert.equal(chatSystemPrompt(prof), chatSystemPrompt(prof));
  const p = chatSystemPrompt(prof);
  assert.doesNotMatch(p, /\b20\d\d-\d\d-\d\d\b/);
  assert.doesNotMatch(p, /Today is/);
});

test("empty instructions still give the model a role", () => {
  assert.match(chatSystemPrompt({ name: "Blank", instructions: "  ", autonomy: "L0" }), /# Your role: Blank\n\nHelp the person/);
});

test("the date and who is asking travel in a <context> block on the message, not in the system prompt", () => {
  const c = contextBlock({ id: 1, name: "Alex", role: "owner" }, new Date("2026-11-14T10:00:00Z"));
  assert.match(c, /^<context>Today is Saturday 14 November 2026 \(2026-11-14, Europe\/Dublin\)\. Asking: Alex \(owner\)\.<\/context>$/);
});

test("default profiles take their instructions from the code agents", () => {
  assert.equal(DEFAULT_BY_SLUG.jarvis.instructions, AGENTS.jarvis.prompt);
  assert.equal(DEFAULT_BY_SLUG.payments.instructions, AGENTS.finance.prompt);
  assert.match(DEFAULT_BY_SLUG.reporting.instructions, /weekly/i);
  assert.deepEqual(
    DEFAULT_PROFILES.map((p) => p.slug),
    ["jarvis", "fulfilment", "reporting", "project-management", "payments", "sales", "inbox", "client-health"],
  );
  assert.equal(DEFAULT_BY_SLUG.jarvis.autonomy, "L0");
  assert.equal(DEFAULT_BY_SLUG.payments.ownerOnly, true);
  for (const p of DEFAULT_PROFILES) if (p.baseAgent) assert.ok(AGENTS[p.baseAgent], `${p.slug} links a real agent`);
});

test("slugs are unique and avoid /chat routes", () => {
  assert.equal(slugify("Ads Review!", []), "ads-review");
  assert.equal(slugify("Ads review", ["ads-review"]), "ads-review-2");
  assert.equal(slugify("New", []), "new-2");
  assert.equal(slugify("   ", []), "agent");
});

// ---------- permissions ----------

test("team members can't use (or see) the Payments agent; owners can", () => {
  const payments = profile("payments");
  assert.equal(canUseProfile("team", payments), false);
  assert.equal(canSeeProfile("team", payments), false);
  assert.equal(canUseProfile("owner", payments), true);
  // Even if someone unticks "owners only", Payments stays owners-only.
  assert.equal(canUseProfile("team", { ...payments, ownerOnly: false }), false);
  assert.equal(canUseProfile(null, profile("jarvis")), false);
});

test("inactive agents can't be chatted with; owners still see them to edit", () => {
  const off = profile("sales", { active: false });
  assert.equal(canUseProfile("owner", off), false);
  assert.equal(canSeeProfile("owner", off), true);
  assert.equal(canSeeProfile("team", off), false);
});

test("only owners edit agents", () => {
  assert.equal(canEditProfiles("owner"), true);
  assert.equal(canEditProfiles("team"), false);
  assert.equal(canEditProfiles(undefined), false);
});

test("a person only sees their own conversations", () => {
  assert.equal(ownsConversation({ id: 3 }, { userId: 3 }), true);
  assert.equal(ownsConversation({ id: 3 }, { userId: 4 }), false);
});

test("team members never get money tools, in any agent", () => {
  for (const t of MONEY_OS_TOOLS) assert.equal(toolAllowedForRole("team", t), false, t);
  assert.equal(toolAllowedForRole("team", "STRIPE_LIST_INVOICES"), false);
  assert.equal(toolAllowedForRole("team", "OS_LIST_TASKS"), true);
  assert.equal(toolAllowedForRole("owner", "OS_GET_RECEIVABLES"), true);

  const jarvis = profile("jarvis");
  assert.ok(osToolsFor("owner", jarvis).includes("OS_GET_RECEIVABLES"));
  assert.ok(!osToolsFor("team", jarvis).some(isMoneyTool));
  assert.ok(toolkitsFor("owner", jarvis).includes("stripe"));
  assert.ok(!toolkitsFor("team", jarvis).includes("stripe"));

  const offered = (role: "owner" | "team") => chatTools(jarvis, role, noExternal).map((t) => ("name" in t ? t.name : ""));
  assert.ok(offered("owner").includes("OS_LIST_PAYMENTS"));
  assert.ok(!offered("team").includes("OS_LIST_PAYMENTS"));
});

test("chat guardrails: money tools blocked for team, unoffered tools blocked, autonomy decides the rest", () => {
  const fulfil = profile("fulfilment");
  const tools = chatTools(fulfil, "team", noExternal);
  const names = new Set(tools.map((t) => ("name" in t ? t.name : "")));
  const team = chatPolicy(fulfil, "team", names);
  assert.equal(decideCall("OS_RECORD_PAYMENT", team).action, "block");
  assert.match((decideCall("OS_GET_RECEIVABLES", team) as { reason: string }).reason, /money/);
  assert.match((decideCall("OS_SCORE_HEALTH", team) as { reason: string }).reason, /isn't one of this agent's tools/);
  assert.equal(decideCall("OS_LIST_TASKS", team).action, "run");
  assert.equal(decideCall("OS_CREATE_TASK", team).action, "propose"); // L1
  // Jarvis is read-only.
  const jarvis = profile("jarvis");
  const jp = chatPolicy(jarvis, "owner", new Set([...chatTools(jarvis, "owner", noExternal).map((t) => ("name" in t ? t.name : "")), "OS_CREATE_TASK"]));
  assert.equal(decideCall("OS_CREATE_TASK", jp).action, "block");
  // Hard blocks hold whatever the agent.
  assert.equal(decideCall("GMAIL_DELETE_MESSAGE", { ...jp, autonomy: "L2", extraBlock: undefined }).action, "block");
});

test("base agent exclusions apply in chat (Inbox can't send email directly)", () => {
  const inbox = profile("inbox");
  const p = chatPolicy(inbox, "owner", new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]));
  assert.equal(decideCall("GMAIL_SEND_EMAIL", p).action, "block");
  assert.equal(decideCall("GMAIL_REPLY_TO_THREAD", p).action, "propose");
});

test("web search is offered only when the profile turns it on", () => {
  const on = chatTools(profile("jarvis", { webSearch: true }), "owner", noExternal);
  const off = chatTools(profile("jarvis", { webSearch: false }), "owner", noExternal);
  assert.ok(on.some((t) => "type" in t && t.type === "web_search_20260209"));
  assert.ok(!off.some((t) => "type" in t && t.type === "web_search_20260209"));
  // Client tools stream their input eagerly (runOsTool validates it).
  assert.ok(on.filter((t) => "name" in t && t.name.startsWith("OS_")).every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming));
});

test("team members don't see client billing fields in tool results", () => {
  const out = JSON.stringify([{ id: 1, name: "Apex", retainerExVat: 1500, vat: "plus", billingMethod: "stripe", stripeCustomerId: "cus_1", status: "active" }]);
  assert.deepEqual(JSON.parse(redactToolResult("team", "OS_LIST_CLIENTS", out)), [{ id: 1, name: "Apex", status: "active" }]);
  assert.equal(redactToolResult("owner", "OS_LIST_CLIENTS", out), out);
  assert.equal(redactToolResult("team", "OS_LIST_TASKS", out), out);
});

// ---------- attachments ----------

const enc = (s: string) => new TextEncoder().encode(s);

test("attachments become the right content blocks", () => {
  const r = toContentBlocks([
    { name: "invoice.pdf", type: "application/pdf", bytes: enc("%PDF-1.4 fake") },
    { name: "ad.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) },
    { name: "leads.csv", type: "application/vnd.ms-excel", bytes: enc("client,leads\nApex,12\n") },
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(
    r.blocks.map((b) => [b.type, (b as { source: { type: string; media_type: string } }).source.type, (b as { source: { media_type: string } }).source.media_type]),
    [
      ["document", "base64", "application/pdf"],
      ["image", "base64", "image/png"],
      ["document", "text", "text/plain"],
    ],
  );
  assert.equal((r.blocks[0] as { title?: string }).title, "invoice.pdf");
  assert.equal((r.blocks[2] as { source: { data: string } }).source.data, "client,leads\nApex,12\n");
  assert.deepEqual(r.attachments.map((a) => a.mediaType), ["application/pdf", "image/png", "text/csv"]);
});

test("attachments are size-limited and type-checked", () => {
  const big = { name: "big.pdf", type: "application/pdf", bytes: new Uint8Array(MAX_TOTAL_BYTES + 1) };
  assert.match((toContentBlocks([big]) as { error: string }).error, /limit is 4\.0 MB/);
  assert.match((toContentBlocks([{ name: "run.exe", type: "application/x-msdownload", bytes: enc("MZ") }]) as { error: string }).error, /only PDF, images/);
  assert.match((toContentBlocks([{ name: "e.csv", type: "text/csv", bytes: new Uint8Array() }]) as { error: string }).error, /empty/);
  assert.match((toContentBlocks(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, type: "text/plain", bytes: enc("x") }))) as { error: string }).error, /at most 5/);
  assert.equal(mediaTypeOf("Report.XLSX", ""), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

/** A minimal .xlsx (stored, uncompressed zip) built by hand. */
function makeXlsx(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

test("XLSX sheets are read as CSV text (shared strings, inline strings, gaps, booleans)", () => {
  const xlsx = makeXlsx({
    "xl/workbook.xml": `<workbook xmlns:r="x"><sheets><sheet name="Leads &amp; spend" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Client</t></si><si><t>Spend</t></si><si><r><t>Apex</t></r><r><t xml:space="preserve">, Attics</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>1234.5</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>hi</t></is></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  });
  const sheets = readXlsx(xlsx);
  assert.deepEqual(sheets.map((s) => s.name), ["Leads & spend", "Two"]);
  assert.deepEqual(sheets[0].rows, [["Client", "Spend"], [], ["Apex, Attics", "", "1234.5"]]);
  assert.equal(xlsxToText(xlsx), `## Sheet: Leads & spend\nClient,Spend\n\n"Apex, Attics",,1234.5\n\n## Sheet: Two\n,hi,TRUE`);
  const r = toContentBlocks([{ name: "s.xlsx", type: "", bytes: xlsx }]);
  assert.ok(r.ok && (r.blocks[0] as { source: { data: string } }).source.data.startsWith("## Sheet: Leads & spend"));
  assert.match((toContentBlocks([{ name: "bad.xlsx", type: "", bytes: enc("not a zip at all, sorry") }]) as { error: string }).error, /couldn't read it/);
});

// ---------- what the chat shows ----------

test("stored API messages become one person message and one reply with tool chips", () => {
  const ui = toUiMessages([
    { id: 1, role: "user", content: [{ type: "text", text: "Who owes us?" }, { type: "text", text: "<context>Today is…</context>" }], attachments: [], toolEvents: [], stopReason: null },
    {
      id: 2,
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "OS_LIST_PAYMENTS", input: { filter: "outstanding" } }],
      attachments: [],
      toolEvents: [{ id: "t1", tool: "OS_LIST_PAYMENTS", input: { filter: "outstanding" }, outcome: "ran", label: "Looked up outstanding payments" }],
      stopReason: "tool_use",
    },
    { id: 3, role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }], attachments: [], toolEvents: [], stopReason: null },
    { id: 4, role: "assistant", content: [{ type: "text", text: "Nobody." }], attachments: [], toolEvents: [], stopReason: "end_turn" },
  ]);
  assert.equal(ui.length, 2);
  assert.deepEqual(ui[0], { id: "m1", role: "user", text: "Who owes us?", attachments: [] });
  const reply = ui[1];
  assert.equal(reply.role, "assistant");
  if (reply.role !== "assistant") return;
  assert.deepEqual(
    reply.parts.map((p) => (p.type === "text" ? p.text : `[${p.event.label}]`)),
    ["Checking.", "[Looked up outstanding payments]", "Nobody."],
  );
  assert.equal(reply.stopReason, "end_turn");
});

test("tool chips read like sentences", () => {
  assert.equal(toolLabel("OS_LIST_PAYMENTS", { filter: "month", month: "2026-10", client_id: 3 }, "Apex Attics"), "Looked up payments for Apex Attics in 2026-10");
  assert.equal(toolLabel("OS_LIST_TASKS", { client_id: 9 }), "Looked up tasks for client #9");
  assert.equal(toolLabel("web_search", { query: "SEAI grants 2026" }), 'Searched the web for "SEAI grants 2026"');
  assert.equal(toolLabel("GMAIL_FETCH_EMAILS", {}), "Gmail: fetch emails");
});

test("conversation titles come from the first message", () => {
  assert.equal(titleFrom("Who owes us money?"), "Who owes us money?");
  assert.equal(titleFrom("  "), "New chat");
  const long = titleFrom("Can you look at every client that signed this year and tell me which of them is behind on onboarding?");
  assert.ok(long.length <= 61 && long.endsWith("…"), long);
});
