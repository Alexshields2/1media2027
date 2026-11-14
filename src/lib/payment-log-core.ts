// The payment log (a tick-box grid of clients x months), as pure functions so the page, the client component
// and the tests share them. No database, config or server-only imports: this file is bundled for the browser too.

export type Method = "stripe" | "invoice" | "revolut" | "aib" | "cash";
export const METHODS: Method[] = ["stripe", "invoice", "revolut", "aib", "cash"];

export interface LogRow {
  id: number;
  clientId: number;
  label: string;
  period: string; // YYYY-MM-01
  amountDue: number;
  amountCollected: number;
  dueDate: string;
  paidDate: string | null;
  method: Method | null;
  notes: string | null;
}

export interface LogClient {
  id: number;
  name: string;
  status: "onboarding" | "active" | "paused" | "churned";
  billingMethod: Method;
  retainerExVat: number;
}

/** paid = in full, part = some money in, unpaid = nothing in yet, none = no payment due that month. */
export type CellState = "paid" | "part" | "unpaid" | "none";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function cellState(row: Pick<LogRow, "amountDue" | "amountCollected"> | undefined | null): CellState {
  if (!row || row.amountDue <= 0.005) return "none";
  if (row.amountCollected >= row.amountDue - 0.005) return "paid";
  if (row.amountCollected > 0.005) return "part";
  return "unpaid";
}

/** Not paid in full and its due date has passed. */
export function isOverdue(row: Pick<LogRow, "amountDue" | "amountCollected" | "dueDate"> | undefined | null, today: string): boolean {
  const s = cellState(row);
  return (s === "unpaid" || s === "part") && row!.dueDate < today;
}

/** What a tick does to a row: paid in full, today unless a date is already there, the client's method unless one is set. */
export function tickedValues(row: Pick<LogRow, "amountDue" | "paidDate" | "method">, client: Pick<LogClient, "billingMethod">, today: string) {
  return { amountCollected: r2(row.amountDue), paidDate: row.paidDate ?? today, method: row.method ?? client.billingMethod };
}

/** What an untick does: back to unpaid. */
export const untickedValues = { amountCollected: 0, paidDate: null } as const;

export interface LogLine {
  /** clientId + label: one grid row per retainer line (a client with two lines per month gets two rows). */
  key: string;
  client: LogClient;
  label: string;
  /** First line of its client (shows the logo and name). */
  first: boolean;
  /** Active and onboarding clients first; paused and churned below. */
  group: "active" | "paused";
  cells: Record<string, LogRow | undefined>;
  paid: number;
  due: number;
}

export interface LogColumn {
  period: string;
  due: number;
  collected: number;
}

export interface PaymentLogData {
  year: number;
  years: number[];
  today: string;
  months: string[];
  lines: LogLine[];
  columns: LogColumn[];
  summary: { collected: number; outstanding: number; unpaidMonths: number; due: number };
}

const isActive = (c: Pick<LogClient, "status">) => c.status === "active" || c.status === "onboarding";

/** The months a year's grid shows: Jan to the current month this year (or later, if a row exists ahead), all 12 for past years. */
export function logMonths(year: number, today: string, rows: Pick<LogRow, "period">[]): string[] {
  const thisYear = Number(today.slice(0, 4));
  const latestRow = rows.filter((r) => r.period.startsWith(`${year}-`)).reduce((m, r) => Math.max(m, Number(r.period.slice(5, 7))), 0);
  const last = year < thisYear ? 12 : year === thisYear ? Math.max(Number(today.slice(5, 7)), latestRow) : latestRow;
  return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
}

export function buildPaymentLog(clients: LogClient[], allRows: LogRow[], year: number, today: string, years?: number[]): PaymentLogData {
  const rows = allRows.filter((r) => r.period.startsWith(`${year}-`));
  const months = logMonths(year, today, rows);
  const inGrid = new Set(months);
  const byClient = new Map<number, LogRow[]>();
  for (const r of rows) byClient.set(r.clientId, [...(byClient.get(r.clientId) ?? []), r]);

  const shown = clients
    .filter((c) => byClient.has(c.id) || (isActive(c) && c.retainerExVat > 0 && Number(today.slice(0, 4)) === year))
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name));

  const lines: LogLine[] = [];
  for (const c of shown) {
    const mine = byClient.get(c.id) ?? [];
    // "Retainer" first, then other lines in the order they first appear.
    const seen = [...new Set([...mine].sort((a, b) => a.period.localeCompare(b.period) || a.id - b.id).map((r) => r.label))];
    const labels = seen.length ? [...seen.filter((l) => l === "Retainer"), ...seen.filter((l) => l !== "Retainer")] : ["Retainer"];
    labels.forEach((label, i) => {
      const cells: Record<string, LogRow | undefined> = {};
      let paid = 0;
      let due = 0;
      for (const r of mine.filter((x) => x.label === label)) {
        if (!inGrid.has(r.period)) continue;
        cells[r.period] = r;
        paid += r.amountCollected;
        due += r.amountDue;
      }
      lines.push({ key: `${c.id}:${label}`, client: c, label, first: i === 0, group: isActive(c) ? "active" : "paused", cells, paid: r2(paid), due: r2(due) });
    });
  }

  const columns = months.map((period) => {
    const inMonth = rows.filter((r) => r.period === period);
    return { period, due: r2(inMonth.reduce((s, r) => s + r.amountDue, 0)), collected: r2(inMonth.reduce((s, r) => s + r.amountCollected, 0)) };
  });

  const counted = rows.filter((r) => inGrid.has(r.period));
  const owedNow = counted.filter((r) => r.dueDate <= today && r.amountCollected < r.amountDue - 0.005);
  const summary = {
    collected: r2(counted.reduce((s, r) => s + r.amountCollected, 0)),
    due: r2(counted.reduce((s, r) => s + r.amountDue, 0)),
    outstanding: r2(owedNow.reduce((s, r) => s + (r.amountDue - r.amountCollected), 0)),
    unpaidMonths: owedNow.length,
  };
  return { year, years: years ?? [year], today, months, lines, columns, summary };
}

/** Month groups for the "By month" list, newest first. */
export function byMonth(data: PaymentLogData) {
  const clientOf = new Map(data.lines.map((l) => [l.client.id, l.client]));
  return [...data.months].reverse().map((period) => {
    const items = data.lines
      .map((l) => l.cells[period])
      .filter((r): r is LogRow => !!r)
      .map((row) => ({ row, client: clientOf.get(row.clientId)! }))
      .sort((a, b) => a.client.name.localeCompare(b.client.name) || a.row.label.localeCompare(b.row.label));
    const col = data.columns.find((c) => c.period === period)!;
    return { period, items, due: col.due, collected: col.collected };
  });
}

// ---------- formatting (no config import, so usable in the browser) ----------

export function money(n: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

export function monthShort(period: string): string {
  return new Date(`${period.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-IE", { month: "short", timeZone: "UTC" });
}

export function monthLong(period: string): string {
  return new Date(`${period.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-IE", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function shortDate(iso: string | null): string {
  if (!iso) return "–";
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
