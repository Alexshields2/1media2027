import "../src/config";
import { eq } from "drizzle-orm";
import { db, schema, closeDb } from "../src/db";
import { requireEnv } from "../src/config";

// One-time, READ-ONLY import of clients and payments from the old Notion OS.
// Nothing is written to Notion.
//
//   1. notion.so/profile/integrations -> New internal integration -> copy the secret.
//   2. In Notion, open "Client Portals" and "Payment Collection" -> ••• -> Connections -> add it.
//   3. NOTION_TOKEN=secret_xxx npm run import:notion
//
// Safe to re-run: clients are matched by name, payments by client + month + line.

const NOTION_VERSION = "2025-09-03";
const CLIENTS_DS = process.env.NOTION_CLIENTS_DS ?? "f0598ec7-8dd1-8365-bc03-877e4a61c759";
const PAYMENTS_DS = process.env.NOTION_PAYMENTS_DS ?? "1596ffdf-32f4-441c-b673-6bb8dd6c43af";

type Props = Record<string, any>;

async function queryAll(dataSourceId: string): Promise<{ id: string; properties: Props }[]> {
  const token = requireEnv("NOTION_TOKEN");
  const out: { id: string; properties: Props }[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { results: { id: string; properties: Props }[]; has_more: boolean; next_cursor: string | null };
    out.push(...json.results);
    cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

const text = (p: any): string | null => {
  if (!p) return null;
  const arr = p.title ?? p.rich_text;
  if (Array.isArray(arr)) return arr.map((t: any) => t.plain_text).join("").trim() || null;
  if (p.type === "email") return p.email;
  if (p.type === "url") return p.url;
  return null;
};
const number = (p: any): number | null => (p?.type === "number" ? p.number : null);
const date = (p: any): string | null => p?.date?.start?.slice(0, 10) ?? null;
const select = (p: any): string | null => p?.select?.name ?? null;
const relationIds = (p: any): string[] => (p?.relation ?? []).map((r: any) => r.id);

const METHOD: Record<string, "stripe" | "invoice" | "revolut" | "aib" | "cash"> = { Stripe: "stripe", Invoice: "invoice", Revolut: "revolut", AIB: "aib", Cash: "cash" };
const VAT: Record<string, "plus" | "inc" | "none"> = { "Plus VAT": "plus", "Inc VAT": "inc", "No VAT": "none" };

async function main() {
  console.log("Reading Notion (read-only)…");
  const [notionClients, notionPayments] = await Promise.all([queryAll(CLIENTS_DS), queryAll(PAYMENTS_DS)]);

  // Latest payment row per client tells us the current retainer, VAT and method.
  const latestByClient = new Map<string, Props>();
  for (const p of notionPayments) {
    const cid = relationIds(p.properties["Client"])[0];
    if (!cid) continue;
    const prev = latestByClient.get(cid);
    if (!prev || (date(p.properties["Due Date"]) ?? "") > (date(prev["Due Date"]) ?? "")) latestByClient.set(cid, p.properties);
  }

  const idMap = new Map<string, number>();
  let createdClients = 0;
  for (const c of notionClients) {
    const name = text(c.properties["Name"]);
    if (!name) continue;
    const latest = latestByClient.get(c.id);
    const statuses: string[] = (c.properties["Status"]?.multi_select ?? []).map((s: any) => s.name);
    const values = {
      name,
      status: (latest || statuses.includes("In Progress") || statuses.includes("Ongoing") ? "active" : "paused") as "active" | "paused",
      email: text(c.properties["Email"]),
      website: text(c.properties["Website URL"]),
      goals: text(c.properties["Goals"]),
      notes: text(c.properties["Company Info"]),
      startDate: date(c.properties["Start Date"]),
      retainerExVat: number(latest?.["Retainer (ex VAT)"]) ?? number(c.properties["Price"]) ?? 0,
      vat: VAT[select(latest?.["VAT"]) ?? ""] ?? "plus",
      billingMethod: METHOD[select(latest?.["Method"]) ?? ""] ?? "invoice",
    };
    const [existing] = await db.select().from(schema.clients).where(eq(schema.clients.name, name));
    if (existing) {
      idMap.set(c.id, existing.id);
    } else {
      const [row] = await db.insert(schema.clients).values(values).returning({ id: schema.clients.id });
      idMap.set(c.id, row.id);
      createdClients++;
    }
  }

  let createdPayments = 0;
  for (const p of notionPayments) {
    const cid = idMap.get(relationIds(p.properties["Client"])[0] ?? "");
    const due = date(p.properties["Due Date"]);
    const amountDue = number(p.properties["Amount Due"]);
    if (!cid || !due || amountDue === null) continue;
    const title = text(p.properties["Payment"]) ?? "";
    const label = /\bAI\b/.test(title) ? "AI retainer" : "Retainer";
    const res = await db
      .insert(schema.payments)
      .values({
        clientId: cid,
        label,
        period: `${due.slice(0, 7)}-01`,
        amountDue,
        amountCollected: number(p.properties["Amount Collected"]) ?? 0,
        dueDate: due,
        paidDate: date(p.properties["Date Paid"]),
        method: METHOD[select(p.properties["Method"]) ?? ""] ?? null,
        notes: text(p.properties["Notes"]),
      })
      .onConflictDoNothing()
      .returning({ id: schema.payments.id });
    createdPayments += res.length;
  }

  console.log(`Clients: ${createdClients} new (${notionClients.length} in Notion). Payments: ${createdPayments} new (${notionPayments.length} in Notion).`);
  console.log("Next: open each client in 1Media OS and fill in Meta ad account IDs, GHL location, CPL target and report rules.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
