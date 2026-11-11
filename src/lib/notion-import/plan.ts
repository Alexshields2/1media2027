import type { Client, Payment } from "../../db/schema";
import { checkbox, date, isEmpty, multi, num, relationIds, select, text, type NotionPage, type SourceKey } from "./notion";

// Pure functions: Notion rows in, a plan of database writes out. No I/O here, so it is all unit-tested.

type Method = NonNullable<Payment["method"]>;
const METHOD: Record<string, Method> = { stripe: "stripe", invoice: "invoice", revolut: "revolut", aib: "aib", cash: "cash" };
const VAT: Record<string, Client["vat"]> = { "plus vat": "plus", "inc vat": "inc", "no vat": "none" };
const method = (s: string | null): Method | null => (s ? (METHOD[s.trim().toLowerCase()] ?? null) : null);

export const SOURCE_TITLES: Record<SourceKey, string> = {
  portals: "Client Portals",
  monthly: "Monthly Reports DB",
  crm: "Sales CRM",
  payments: "Payment Collection",
};
const PRIORITY: SourceKey[] = ["portals", "crm", "monthly"];

// ---------- normalising ----------

const SUFFIXES = new Set(["ltd", "limited", "teoranta", "t/a", "ie", "ireland", "irl", "the", "co", "company", "group", "services"]);

/** "The Paving Co. Ltd" and "paving co" both become "paving". Used only for matching, never stored. */
export function normaliseName(s: string | null | undefined): string {
  if (!s) return "";
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\.(ie|com|co\.uk|net)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.filter((w) => !SUFFIXES.has(w));
  return (kept.length ? kept : words).join(" ");
}

export function normaliseEmail(s: string | null | undefined): string {
  const e = (s ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
}

// ---------- client records from each list ----------

export type ClientFields = Partial<
  Pick<
    Client,
    | "name" | "status" | "contactName" | "email" | "phone" | "website" | "retainerExVat" | "vat" | "billingMethod" | "startDate"
    | "metaAdAccountIds" | "ghlLocationId" | "stripeCustomerId" | "cplTarget" | "reportCurrency" | "reportGreeting" | "reportRules" | "goals" | "notes"
  >
>;

export interface ClientRecord {
  source: SourceKey;
  pageId: string;
  label: string; // the name as written in Notion, for the report
  fields: ClientFields;
  /** Notion page ids this row explicitly links to (e.g. Sales CRM "Client Portals WON"). */
  links: string[];
}

export interface Skip {
  source: SourceKey;
  pageId: string;
  label: string;
  reason: string;
}

export interface Unmapped {
  source: SourceKey;
  field: string;
  rows: number;
  why: string;
}

/** Properties we read, per source. Anything else with a value shows up in the report as unmapped. */
export const MAPPED: Record<SourceKey, string[]> = {
  portals: ["Name", "Email", "Website URL", "Goals", "Company Info", "Start Date", "End Date", "Price", "Billing Method", "CPL Target", "GHL Location ID", "Meta Ad Account IDs", "Stripe Customer ID", "Report Currency", "Report Greeting", "Report Rules", "Active", "Status", "👟 Sales CRM"],
  monthly: ["Name", "Website.", "Reporting Notes.", "Client Name:", "active"],
  crm: ["Name", "Company", "Email", "Phone", "Stage", "Client Portals WON"],
  payments: ["Payment", "Client", "Due Date", "Amount Due", "Amount Collected", "Paid", "Date Paid", "Method", "Notes", "Retainer (ex VAT)", "VAT"],
};

/** Why a field with data is deliberately not imported. */
const WHY: Record<string, string> = {
  "Account Manager": "no account-manager column yet (BLUEPRINT §5)",
  "Slack Channel": "no Slack channel column yet (BLUEPRINT §5)",
  "Google Drive Link": "no Drive folder column yet (BLUEPRINT §5)",
  "Client Access": "Notion portal sharing; not used by 1Media OS",
  "Time Entries": "time tracking is not part of 1Media OS",
  Address: "no address columns",
  City: "no address columns",
  State: "no address columns",
  Country: "no address columns",
  "Postal Code": "no address columns",
  Competitors: "no column; copy into notes by hand if useful",
  "Target Keywords": "no column; copy into notes by hand if useful",
  Client: "links to an older Notion clients list that isn't imported",
  "Estimated Value": "sales estimate, not the retainer",
  "Account Owner": "Notion person; no column",
  Contact: "Notion person; no column",
  Priority: "sales-pipeline field",
  "Last Contact": "sales-pipeline field",
  "Expected Close": "sales-pipeline field",
};

export function unmappedFields(source: SourceKey, pages: NotionPage[]): Unmapped[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const [k, v] of Object.entries(p.properties)) {
      if (MAPPED[source].includes(k) || isEmpty(v)) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([field, rows]) => ({ source, field, rows, why: WHY[field] ?? "no matching column in 1Media OS" }));
}

/** The latest "Retainer" line per Client Portals page tells us the current retainer, VAT and method. */
export function latestRetainerByPortal(payments: NotionPage[]): Map<string, NotionPage> {
  const latest = new Map<string, NotionPage>();
  for (const p of payments) {
    if (p.archived || p.in_trash) continue;
    if (paymentLabel(text(p.properties["Payment"])) !== "Retainer") continue;
    const cid = relationIds(p.properties["Client"])[0];
    if (!cid) continue;
    const prev = latest.get(cid);
    if (!prev || (date(p.properties["Due Date"]) ?? "") > (date(prev.properties["Due Date"]) ?? "")) latest.set(cid, p);
  }
  return latest;
}

/** Client status from the portal's Active box, Status tags and End Date. */
export function portalStatus(page: NotionPage, hasRecentPayment: boolean, today: string): Client["status"] {
  const P = page.properties;
  const end = date(P["End Date"]);
  const tags = multi(P["Status"]);
  if (end && end < today) return "churned";
  if (checkbox(P["Active"])) return "active";
  if (tags.includes("Completed")) return "churned";
  if (tags.includes("In Progress") || tags.includes("Ongoing")) return "active";
  if (tags.includes("On Hold")) return "paused";
  if (tags.includes("Upcoming")) return "onboarding";
  return hasRecentPayment ? "active" : "paused";
}

/** Drops blanks, so "no value in Notion" never overwrites anything. */
const clean = (o: Record<string, unknown>): ClientFields => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as ClientFields;

export function fromPortal(page: NotionPage, latest: NotionPage | undefined, recentPortals: Set<string>, today: string): ClientRecord | Skip {
  const P = page.properties;
  const name = text(P["Name"]);
  if (page.archived || page.in_trash) return { source: "portals", pageId: page.id, label: name ?? page.id, reason: "archived in Notion" };
  if (!name) return { source: "portals", pageId: page.id, label: `untitled page ${page.id}`, reason: "no name" };
  const L = latest?.properties ?? {};
  const currency = select(P["Report Currency"]);
  return {
    source: "portals",
    pageId: page.id,
    label: name,
    links: relationIds(P["👟 Sales CRM"]),
    fields: clean({
      name,
      status: portalStatus(page, recentPortals.has(page.id), today),
      email: normaliseEmail(text(P["Email"])) || null,
      website: text(P["Website URL"]),
      goals: text(P["Goals"]),
      notes: text(P["Company Info"]),
      startDate: date(P["Start Date"]),
      retainerExVat: num(L["Retainer (ex VAT)"]) ?? num(P["Price"]),
      vat: VAT[(select(L["VAT"]) ?? "").toLowerCase()],
      billingMethod: method(select(P["Billing Method"])) ?? method(select(L["Method"])),
      cplTarget: num(P["CPL Target"]),
      metaAdAccountIds: text(P["Meta Ad Account IDs"]),
      ghlLocationId: text(P["GHL Location ID"]),
      stripeCustomerId: text(P["Stripe Customer ID"]),
      reportCurrency: currency === "USD" || currency === "EUR" ? currency : null,
      reportGreeting: text(P["Report Greeting"]),
      reportRules: text(P["Report Rules"]),
    }),
  };
}

export function fromMonthly(page: NotionPage): ClientRecord | Skip {
  const P = page.properties;
  const name = text(P["Name"]);
  if (page.archived || page.in_trash) return { source: "monthly", pageId: page.id, label: name ?? page.id, reason: "archived in Notion" };
  if (!name) return { source: "monthly", pageId: page.id, label: `untitled page ${page.id}`, reason: "no name" };
  const note = text(P["Client Name:"]);
  return {
    source: "monthly",
    pageId: page.id,
    label: name,
    links: [],
    fields: clean({
      name,
      status: select(P["active"]) === "active" ? "active" : "paused",
      website: text(P["Website."]),
      reportRules: text(P["Reporting Notes."]),
      notes: note ? `Monthly-report notes (Notion): ${note}` : null,
    }),
  };
}

export function fromCrm(page: NotionPage): ClientRecord | Skip {
  const P = page.properties;
  const person = text(P["Name"]);
  const company = text(P["Company"]);
  const name = company ?? person;
  const label = name ?? page.id;
  if (page.archived || page.in_trash) return { source: "crm", pageId: page.id, label, reason: "archived in Notion" };
  const stage = select(P["Stage"]);
  if (stage !== "Won") return { source: "crm", pageId: page.id, label, reason: `prospect, not a client (stage: ${stage ?? "none"})` };
  if (!name) return { source: "crm", pageId: page.id, label, reason: "no name or company" };
  return {
    source: "crm",
    pageId: page.id,
    label: name,
    links: relationIds(P["Client Portals WON"]),
    fields: clean({
      name,
      status: "active" as const,
      contactName: company && person && normaliseName(person) !== normaliseName(company) ? person : null,
      email: normaliseEmail(text(P["Email"])) || null,
      phone: text(P["Phone"]),
    }),
  };
}

// ---------- dedupe ----------

export interface ClientGroup {
  key: string; // stable: the first Notion page id in priority order
  records: ClientRecord[];
  fields: ClientFields;
  notionIds: string[];
  /** Fields where the lists disagree; the higher-priority list wins. */
  disagreements: string[];
}

/**
 * Groups rows from the three client lists that are the same business.
 * Two rows are the same client when one links to the other, their names normalise the same,
 * or (across different lists) they share an email. Two Client Portals pages are never merged on email alone,
 * because separate clients sometimes share a bookkeeper's address.
 */
export function groupClients(records: ClientRecord[]): ClientGroup[] {
  const parent = records.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byPage = new Map(records.map((r, i) => [r.pageId, i]));
  const byName = new Map<string, number>();
  const byEmail = new Map<string, number[]>();
  records.forEach((r, i) => {
    for (const l of r.links) if (byPage.has(l)) union(i, byPage.get(l)!);
    const n = normaliseName(r.fields.name);
    if (n) byName.has(n) ? union(i, byName.get(n)!) : byName.set(n, i);
    const e = normaliseEmail(r.fields.email);
    if (e) {
      for (const j of byEmail.get(e) ?? []) if (records[j].source !== r.source || r.source !== "portals") union(i, j);
      byEmail.set(e, [...(byEmail.get(e) ?? []), i]);
    }
  });

  const groups = new Map<number, ClientRecord[]>();
  records.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(rs: ClientRecord[]): ClientGroup {
  const records = [...rs].sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source));
  const fields: ClientFields = {};
  const disagreements: string[] = [];
  const notes: string[] = [];
  for (const r of records) {
    for (const [k, v] of Object.entries(r.fields) as [keyof ClientFields, never][]) {
      if (k === "notes") {
        if (!notes.includes(v)) notes.push(v);
        continue;
      }
      if (fields[k] === undefined) (fields as Record<string, unknown>)[k] = v;
      else if (k !== "name" && k !== "status" && String(fields[k]).trim().toLowerCase() !== String(v).trim().toLowerCase())
        disagreements.push(`${k}: kept "${fields[k]}" (${SOURCE_TITLES[records[0].source]}) over "${v}" (${SOURCE_TITLES[r.source]})`);
    }
  }
  if (notes.length) fields.notes = notes.join("\n\n");
  // A client in the portal list keeps the portal's status; one only in other lists is only active if one says so.
  return { key: records[0].pageId, records, fields, notionIds: records.map((r) => r.pageId), disagreements };
}

// ---------- matching against the database ----------

export type ExistingClient = Pick<Client, "id" | "name" | "email" | "notionIds"> & ClientFields;

const FILLABLE: (keyof ClientFields)[] = [
  "contactName", "email", "phone", "website", "retainerExVat", "startDate", "metaAdAccountIds", "ghlLocationId",
  "stripeCustomerId", "cplTarget", "reportRules", "goals", "notes",
];
const blank = (v: unknown) => v === null || v === undefined || v === "" || v === 0;

export type ClientAction =
  | { kind: "create"; group: ClientGroup; values: ClientFields & { name: string } }
  | { kind: "update"; group: ClientGroup; id: number; name: string; set: ClientFields; addIds: string[]; notionIds: string[]; matchedBy: string }
  | { kind: "unchanged"; group: ClientGroup; id: number; name: string; matchedBy: string };

/**
 * Decides, per group, whether to create a client or fill in an existing one.
 * Existing values are never overwritten: the import only fills blanks, so edits made in 1Media OS survive a re-run.
 */
export function planClients(groups: ClientGroup[], existing: ExistingClient[]): ClientAction[] {
  return groups.map((g) => {
    const ids = new Set(g.notionIds);
    const names = new Set(g.records.map((r) => normaliseName(r.fields.name)));
    const emails = new Set(g.records.map((r) => normaliseEmail(r.fields.email)).filter(Boolean));
    let matchedBy = "Notion id";
    let match = existing.find((c) => (c.notionIds ?? []).some((i) => ids.has(i)));
    if (!match) {
      matchedBy = "name";
      match = existing.find((c) => names.has(normaliseName(c.name)));
    }
    if (!match) {
      matchedBy = "email";
      match = existing.find((c) => emails.has(normaliseEmail(c.email)));
    }
    if (!match) return { kind: "create", group: g, values: { ...g.fields, name: g.fields.name! } };

    const set: ClientFields = {};
    for (const k of FILLABLE) if (blank(match[k]) && !blank(g.fields[k])) (set as Record<string, unknown>)[k] = g.fields[k];
    // "Hi guys" is the column default; a Notion greeting replaces it once.
    if (g.fields.reportGreeting && (!match.reportGreeting || match.reportGreeting === "Hi guys") && g.fields.reportGreeting !== match.reportGreeting)
      set.reportGreeting = g.fields.reportGreeting;
    const addIds = g.notionIds.filter((i) => !(match.notionIds ?? []).includes(i));
    if (!Object.keys(set).length && !addIds.length) return { kind: "unchanged", group: g, id: match.id, name: match.name, matchedBy };
    return { kind: "update", group: g, id: match.id, name: match.name, set, addIds, notionIds: [...(match.notionIds ?? []), ...addIds], matchedBy };
  });
}

// ---------- payments ----------

/** Line label from the Notion "Payment" title. Matches the labels the billing job and Payments page use. */
export function paymentLabel(title: string | null): string {
  const t = title ?? "";
  if (/\bAI\b/.test(t)) return "AI retainer";
  if (/set[\s-]?up/i.test(t)) return "Setup fee";
  if (/deposit/i.test(t)) return "Deposit";
  if (/website/i.test(t)) return "Website";
  return "Retainer";
}

export interface PaymentDraft {
  notionPageId: string;
  clientKey: string; // ClientGroup.key
  title: string;
  label: string;
  period: string;
  amountDue: number;
  amountCollected: number;
  dueDate: string;
  paidDate: string | null;
  method: Method | null;
  notes: string | null;
  /** Paid was ticked but Amount Collected was blank, so we assumed it was paid in full. */
  inferredPaid: boolean;
}

export function fromPayment(page: NotionPage, groupOfPortal: Map<string, string>): PaymentDraft | Skip {
  const P = page.properties;
  const title = text(P["Payment"]) ?? "(untitled)";
  const skip = (reason: string): Skip => ({ source: "payments", pageId: page.id, label: title, reason });
  if (page.archived || page.in_trash) return skip("archived in Notion");
  const portals = relationIds(P["Client"]);
  if (!portals.length) return skip("no Client linked");
  const clientKey = groupOfPortal.get(portals[0]);
  if (!clientKey) return skip("linked client isn't in Client Portals (deleted, or not shared with the integration)");
  const due = date(P["Due Date"]);
  if (!due) return skip("no Due Date");
  const amountDue = num(P["Amount Due"]);
  if (amountDue === null) return skip("no Amount Due");
  const collected = num(P["Amount Collected"]);
  const paid = checkbox(P["Paid"]) ?? false;
  return {
    notionPageId: page.id,
    clientKey,
    title,
    label: paymentLabel(title),
    period: `${due.slice(0, 7)}-01`,
    amountDue,
    amountCollected: collected ?? (paid ? amountDue : 0),
    dueDate: due,
    paidDate: date(P["Date Paid"]),
    method: method(select(P["Method"])),
    notes: text(P["Notes"]),
    inferredPaid: collected === null && paid,
  };
}

export type ExistingPayment = Pick<Payment, "id" | "clientId" | "period" | "label" | "amountDue" | "amountCollected" | "paidDate" | "method" | "notes" | "notionPageId">;
type PaymentSet = Partial<Pick<Payment, "amountCollected" | "paidDate" | "method" | "notes" | "notionPageId">>;

export type PaymentAction =
  | { kind: "create"; draft: PaymentDraft; clientId: number }
  | { kind: "merge"; draft: PaymentDraft; id: number; set: PaymentSet; notes: string[] } // fills a row the billing job (or a person) already made
  | { kind: "update"; draft: PaymentDraft; id: number; set: PaymentSet; notes: string[] }
  | { kind: "unchanged"; draft: PaymentDraft; id: number; notes: string[] }
  | { kind: "skip"; draft: PaymentDraft; reason: string };

/**
 * Matches each Notion payment to an existing row by Notion id, then by client + month + line
 * (the same key the billing job uses), so rows the billing job already created are filled in, not duplicated.
 * As with clients, values already in 1Media OS win: collected amounts recorded by Stripe or by hand are never lowered.
 */
export function planPayments(drafts: PaymentDraft[], clientIdOf: Map<string, number>, existing: ExistingPayment[]): PaymentAction[] {
  const byNotion = new Map(existing.filter((p) => p.notionPageId).map((p) => [p.notionPageId!, p]));
  const k = (clientId: number, period: string, label: string) => `${clientId}|${period}|${label}`;
  const byKey = new Map(existing.map((p) => [k(p.clientId, p.period, p.label), p]));
  const claimed = new Map<string, string>(); // key -> Notion page that took it in this run

  return drafts.map((d): PaymentAction => {
    const clientId = clientIdOf.get(d.clientKey)!;
    const key = k(clientId, d.period, d.label);
    const prior = claimed.get(key);
    if (prior && prior !== d.notionPageId) return { kind: "skip", draft: d, reason: `second Notion row for the same client, month and line (${d.label}); the first one was imported. Rename one in Notion (e.g. "Setup fee") or add it by hand` };
    let row = byNotion.get(d.notionPageId);
    let kind: "update" | "merge" = "update";
    if (!row) {
      const same = byKey.get(key);
      if (same?.notionPageId && same.notionPageId !== d.notionPageId)
        return { kind: "skip", draft: d, reason: `second Notion row for the same client, month and line (${d.label}); the first one was imported. Rename one in Notion (e.g. "Setup fee") or add it by hand` };
      row = same;
      kind = "merge";
    }
    claimed.set(key, d.notionPageId);
    if (!row) {
      byKey.set(key, { id: -1, clientId, period: d.period, label: d.label, amountDue: d.amountDue, amountCollected: d.amountCollected, paidDate: d.paidDate, method: d.method, notes: d.notes, notionPageId: d.notionPageId });
      return { kind: "create", draft: d, clientId };
    }

    const set: PaymentSet = {};
    const notes: string[] = [];
    if (row.notionPageId !== d.notionPageId) set.notionPageId = d.notionPageId;
    if (row.amountCollected === 0 && d.amountCollected > 0) set.amountCollected = d.amountCollected;
    else if (d.amountCollected > 0 && Math.abs(row.amountCollected - d.amountCollected) > 0.005)
      notes.push(`kept €${row.amountCollected} collected in 1Media OS; Notion says €${d.amountCollected}`);
    if (!row.paidDate && d.paidDate) set.paidDate = d.paidDate;
    if (!row.method && d.method) set.method = d.method;
    if (!row.notes && d.notes) set.notes = d.notes;
    if (Math.abs(row.amountDue - d.amountDue) > 0.005) notes.push(`amount due differs: €${row.amountDue} in 1Media OS, €${d.amountDue} in Notion (kept 1Media OS)`);
    if (!Object.keys(set).length) return { kind: "unchanged", draft: d, id: row.id, notes };
    return { kind, draft: d, id: row.id, set, notes };
  });
}
