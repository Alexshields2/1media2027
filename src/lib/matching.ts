import type { MatchSuggestion } from "../db/schema";
import { daysBetween } from "./dates";

// Pure matching and aging logic (no database), shared by the Stripe webhook, the bank CSV import,
// the Payments page and the finance agent.

export interface Credit {
  date: string;
  amount: number;
  payer?: string | null;
  reference?: string | null;
  description?: string | null;
  /** "revolut", "aib" or "stripe": a client whose billing method matches gets a small bonus. */
  channel?: string | null;
}

export interface OpenRow {
  id: number;
  clientId: number;
  clientName: string;
  contactName?: string | null;
  email?: string | null;
  billingMethod?: string | null;
  label?: string;
  period: string;
  dueDate: string;
  amountDue: number;
  amountCollected: number;
  stripeInvoiceId?: string | null;
}

/** Score at or above which a candidate is shown as "Suggested". The owner still confirms. */
export const SUGGEST_AT = 50;
/** Candidates below this aren't listed at all. */
const LIST_AT = 25;

const STOP = new Set([
  "ltd", "limited", "the", "and", "co", "company", "group", "services", "service", "ireland", "irl", "teo", "llc",
  "inc", "plc", "uc", "dac", "payment", "transfer", "sepa", "credit", "from", "inst", "instant", "bank", "giro", "to", "for",
]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function tokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

/** Scores how likely a credit pays a given open row. Returns null when the row is out of the date window. */
export function scoreMatch(credit: Credit, row: OpenRow): MatchSuggestion | null {
  const owed = Math.round((row.amountDue - row.amountCollected) * 100) / 100;
  if (owed <= 0.005) return null;
  // Date window: from 21 days before the due date (early payers) to 150 days after.
  const lag = daysBetween(row.dueDate, credit.date);
  if (lag < -21 || lag > 150) return null;

  let score = 0;
  const reasons: string[] = [];

  if (near(credit.amount, owed)) {
    score += 45;
    reasons.push("amount matches the balance");
  } else if (near(credit.amount, row.amountDue)) {
    score += 35;
    reasons.push("amount matches the full charge");
  } else if (Math.abs(credit.amount - owed) / owed <= 0.02) {
    score += 25;
    reasons.push("amount within 2%");
  } else if (credit.amount < owed) {
    score += 8;
    reasons.push("could be a part payment");
  }

  const text = new Set(tokens([credit.payer, credit.reference, credit.description].filter(Boolean).join(" ")));
  const nameTokens = [...new Set(tokens(row.clientName))];
  const hits = nameTokens.filter((t) => text.has(t));
  const extra = [...tokens(row.contactName), ...tokens(row.email?.split("@")[1]?.split(".")[0])].filter((t) => t.length >= 4 && text.has(t));
  if (nameTokens.length && hits.length === nameTokens.length) {
    score += 35;
    reasons.push("client name in payer/reference");
  } else if (hits.length && hits.length * 2 >= nameTokens.length) {
    score += 25;
    reasons.push(`"${hits.join(" ")}" in payer/reference`);
  } else if (hits.some((h) => h.length >= 4) || extra.length) {
    score += 12;
    reasons.push(`"${[...hits, ...extra].join(" ")}" in payer/reference`);
  }

  if (lag >= -7 && lag <= 30) {
    score += 20;
    reasons.push(lag >= 0 ? `paid ${lag} day${lag === 1 ? "" : "s"} after due` : `paid ${-lag} days early`);
  } else if (lag <= 90) {
    score += 10;
    reasons.push(lag > 0 ? `paid ${lag} days after due` : `paid ${-lag} days early`);
  }

  // A month named in the reference outweighs the payment date: "1MEDIA OCT" paid in November is for October.
  const month = MONTHS[Number(row.period.slice(5, 7)) - 1];
  const named = MONTHS.filter((m) => text.has(m));
  if (month && named.includes(month)) {
    score += 15;
    reasons.push(`mentions ${month}`);
  } else if (named.length) {
    score -= 10;
    reasons.push(`mentions ${named.join("/")}, not ${month}`);
  }
  if (credit.channel && row.billingMethod === credit.channel) {
    score += 5;
    reasons.push(`client pays by ${credit.channel}`);
  }
  return { paymentId: row.id, score, reasons };
}

/** Best candidates for a credit, highest score first (oldest due date breaks ties). */
export function suggestMatches(credit: Credit, rows: OpenRow[], limit = 3): MatchSuggestion[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .map((r) => scoreMatch(credit, r))
    .filter((s): s is MatchSuggestion => !!s && s.score >= LIST_AT)
    .sort((a, b) => b.score - a.score || byId.get(a.paymentId)!.dueDate.localeCompare(byId.get(b.paymentId)!.dueDate))
    .slice(0, limit);
}

// ---------- aging ----------

export const AGING_BUCKETS = [
  { key: "0-14", label: "0–14 days", min: 0, max: 14 },
  { key: "15-30", label: "15–30 days", min: 15, max: 30 },
  { key: "31-60", label: "31–60 days", min: 31, max: 60 },
  { key: "60+", label: "60+ days", min: 61, max: Infinity },
] as const;

export type AgingKey = (typeof AGING_BUCKETS)[number]["key"];

export function agingBucket(daysPastDue: number): AgingKey | null {
  if (daysPastDue < 0) return null;
  return AGING_BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max)!.key;
}

export interface AgingInput {
  clientId: number;
  clientName: string;
  dueDate: string;
  owed: number;
}

export interface ClientBalance {
  clientId: number;
  clientName: string;
  balance: number;
  rows: number;
  oldestDays: number;
  buckets: Record<AgingKey, number>;
}

const emptyBuckets = (): Record<AgingKey, number> => ({ "0-14": 0, "15-30": 0, "31-60": 0, "60+": 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Splits money owed on rows already due (due date today or earlier) into aging buckets, in total and per client. */
export function aging(rows: AgingInput[], on: string) {
  const totals = emptyBuckets();
  const counts = emptyBuckets();
  const clients = new Map<number, ClientBalance>();
  for (const r of rows) {
    if (r.owed <= 0.005) continue;
    const days = daysBetween(r.dueDate, on);
    const b = agingBucket(days);
    if (!b) continue;
    totals[b] = r2(totals[b] + r.owed);
    counts[b] += 1;
    const c = clients.get(r.clientId) ?? { clientId: r.clientId, clientName: r.clientName, balance: 0, rows: 0, oldestDays: 0, buckets: emptyBuckets() };
    c.balance = r2(c.balance + r.owed);
    c.rows += 1;
    c.oldestDays = Math.max(c.oldestDays, days);
    c.buckets[b] = r2(c.buckets[b] + r.owed);
    clients.set(r.clientId, c);
  }
  const total = r2(Object.values(totals).reduce((s, n) => s + n, 0));
  return { totals, counts, total, clients: [...clients.values()].sort((a, b) => b.balance - a.balance || a.clientName.localeCompare(b.clientName)) };
}
