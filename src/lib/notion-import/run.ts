import { addMonths, monthStart, today as todayFn } from "../dates";
import { date, queryAll, relationIds, sourceId, SOURCES, type Env, type FetchLike, type NotionPage, type SourceKey } from "./notion";
import {
  fromCrm, fromMonthly, fromPayment, fromPortal, groupClients, latestRetainerByPortal, normaliseName, planClients, planPayments, unmappedFields,
  SOURCE_TITLES, type ClientAction, type ClientFields, type ClientRecord, type ExistingClient, type ExistingPayment, type PaymentAction, type PaymentDraft, type Skip, type Unmapped,
} from "./plan";

/** Where the import reads and writes 1Media OS data. The real one is Postgres (store.ts); tests use memory. */
export interface Store {
  clients(): Promise<ExistingClient[]>;
  payments(): Promise<ExistingPayment[]>;
  /** Runs all writes atomically. */
  write(fn: (w: Writer) => Promise<void>): Promise<void>;
}
export interface Writer {
  createClient(values: ClientFields & { name: string; notionIds: string[] }): Promise<number>;
  updateClient(id: number, set: ClientFields, notionIds: string[]): Promise<void>;
  createPayment(values: Omit<PaymentDraft, "clientKey" | "title" | "inferredPaid"> & { clientId: number }): Promise<void>;
  updatePayment(id: number, set: Partial<ExistingPayment>): Promise<void>;
}

export interface ImportOptions {
  dryRun: boolean;
  token: string;
  fetch?: FetchLike;
  env?: Env;
  /** null = no database available (dry run only): plan against an empty database. */
  store: Store | null;
  today?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ImportReport {
  dryRun: boolean;
  plannedAgainstEmptyDb: boolean;
  sources: { key: SourceKey; title: string; rows: number; error?: string }[];
  clients: ClientAction[];
  clientSkips: Skip[];
  payments: PaymentAction[];
  paymentSkips: Skip[];
  unmapped: Unmapped[];
  warnings: string[];
}

export async function runImport(opts: ImportOptions): Promise<ImportReport> {
  const env = opts.env ?? process.env;
  const today = opts.today ?? todayFn();
  const warnings: string[] = [];

  // 1. Read Notion (read-only).
  const pages = {} as Record<SourceKey, NotionPage[]>;
  const sources: ImportReport["sources"] = [];
  for (const s of SOURCES) {
    try {
      pages[s.key] = await queryAll(sourceId(s, env), { token: opts.token, fetch: opts.fetch, sleep: opts.sleep });
      sources.push({ key: s.key, title: s.title, rows: pages[s.key].length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (s.required) throw new Error(`Couldn't read "${s.title}" from Notion: ${msg}\nShare that database with the integration (••• → Connections) or set ${s.envVar}.`);
      pages[s.key] = [];
      sources.push({ key: s.key, title: s.title, rows: 0, error: `${msg.split("\n")[0].slice(0, 160)} — skipped; share it with the integration to include it` });
    }
  }

  // 2. Map and dedupe clients.
  const latest = latestRetainerByPortal(pages.payments);
  const recentFrom = addMonths(monthStart(today), -2);
  const recent = new Set(pages.payments.filter((p) => (date(p.properties["Due Date"]) ?? "") >= recentFrom).flatMap((p) => relationIds(p.properties["Client"])));
  const records: ClientRecord[] = [];
  const clientSkips: Skip[] = [];
  const take = (r: ClientRecord | Skip) => ("reason" in r ? clientSkips.push(r) : records.push(r));
  for (const p of pages.portals) take(fromPortal(p, latest.get(p.id), recent, today));
  for (const p of pages.monthly) take(fromMonthly(p));
  for (const p of pages.crm) take(fromCrm(p));
  const groups = groupClients(records);

  for (const g of groups) {
    const portals = g.records.filter((r) => r.source === "portals");
    const names = new Set(portals.map((r) => r.label));
    if (new Set(portals.map((r) => normaliseName(r.label))).size > 1) warnings.push(`Merged ${portals.length} Client Portals pages into one client: ${[...names].join(" / ")}. Check they really are the same business.`);
    for (const d of g.disagreements) warnings.push(`${g.fields.name}: lists disagree on ${d}`);
  }

  // 3. Plan clients against the database.
  const existingClients = opts.store ? await opts.store.clients() : [];
  if (!opts.store) warnings.push("No DATABASE_URL: planned against an empty database, so everything shows as new.");
  const clientActions = planClients(groups, existingClients);

  // 4. Payments.
  const groupOfPortal = new Map<string, string>();
  for (const g of groups) for (const r of g.records) if (r.source === "portals") groupOfPortal.set(r.pageId, g.key);
  const drafts: PaymentDraft[] = [];
  const paymentSkips: Skip[] = [];
  for (const p of pages.payments) {
    const d = fromPayment(p, groupOfPortal);
    "reason" in d ? paymentSkips.push(d) : drafts.push(d);
  }
  const aiOnly = new Set(drafts.filter((d) => d.label === "AI retainer").map((d) => d.clientKey));
  for (const g of groups) if (aiOnly.has(g.key)) warnings.push(`${g.fields.name} has an "AI retainer" line in Notion. The monthly billing job only creates the main retainer; add AI lines by hand each month for now.`);

  const existingPayments = opts.store ? await opts.store.payments() : [];
  const clientIdOf = new Map<string, number>();
  let fakeId = -1;
  for (const a of clientActions) clientIdOf.set(a.group.key, a.kind === "create" ? fakeId-- : a.id);
  let paymentActions = planPayments(drafts, clientIdOf, existingPayments);

  // 5. Write (unless dry run). Clients first, so new clients have ids for their payments.
  if (!opts.dryRun) {
    if (!opts.store) throw new Error("A real import needs DATABASE_URL.");
    await opts.store.write(async (w) => {
      for (const a of clientActions) {
        if (a.kind === "create") clientIdOf.set(a.group.key, await w.createClient({ ...a.values, notionIds: a.group.notionIds }));
        else if (a.kind === "update") await w.updateClient(a.id, a.set, a.notionIds);
      }
      paymentActions = planPayments(drafts, clientIdOf, existingPayments);
      for (const a of paymentActions) {
        if (a.kind === "create") {
          const { clientKey: _k, title: _t, inferredPaid: _i, ...values } = a.draft;
          await w.createPayment({ ...values, clientId: a.clientId });
        } else if (a.kind === "merge" || a.kind === "update") await w.updatePayment(a.id, a.set);
      }
    });
  }

  // Only rows we actually import count towards "fields not imported" (a prospect's Priority isn't a gap).
  const skipped = new Set([...clientSkips, ...paymentSkips].map((s) => s.pageId));
  const unmapped = SOURCES.flatMap((s) => unmappedFields(s.key, pages[s.key].filter((p) => !skipped.has(p.id))));
  return { dryRun: opts.dryRun, plannedAgainstEmptyDb: !opts.store, sources, clients: clientActions, clientSkips, payments: paymentActions, paymentSkips, unmapped, warnings };
}

export { SOURCE_TITLES };
